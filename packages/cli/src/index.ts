#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { bundleEventCount, eventKindCounts, validateIrBundle } from '@sessionport/core';
import type { IrBundle, IrNotice } from '@sessionport/core';
import { readKimiBundle, summarizeBundle } from '@sessionport/adapter-kimi-code';
import { printWriteReport, resumeSmoke, verifyClaudeSession, writeClaudeSession } from '@sessionport/adapter-claude-code';

const USAGE = [
  'sessionport — 在 AI 编程 agent 之间搬运会话',
  '',
  '用法:',
  '  sessionport inspect <source>',
  '  sessionport pull <source> [--out ir.json]',
  '  sessionport push <source> --to claude-code [options]',
  '  sessionport verify --config-dir <dir> --cwd <dir> --session-id <uuid> [--resume]',
  '',
  '<source> 形式:',
  '  kimi:<bundle 目录>     Kimi Code 会话目录（kimi export 解包目录或原生会话目录）',
  '  <目录>                 同上，自动识别 state.json',
  '  <ir.json>              已有 IR 文件',
  '',
  'push 选项:',
  '  --to <agent>           目标 agent（当前支持 claude-code）',
  '  --config-dir <dir>     目标 Claude 配置目录（默认 $CLAUDE_CONFIG_DIR 或 ~/.claude）',
  '  --cwd <dir>            目标会话 cwd（默认取源会话 cwd）',
  '  --session-id <uuid>    指定目标会话 id',
  '  --model <name>         assistant message 的 model 字段',
  '  --version <ver>        写入每行的目标 CLI 版本（默认 2.1.303）',
  '  --keep-thinking        把 thinking 降级为 text 块而不是丢弃',
  '  --dry-run              只生成不落盘',
  '  --write-ir <file>      同时把 IR 落盘',
  '',
  'verify 选项:',
  '  --resume               额外跑一次无头 resume（会真实调用模型）',
].join('\n');

function fail(message: string): never {
  process.stderr.write('错误: ' + message + '\n');
  process.exit(1);
}

function isKimiDir(path: string): boolean {
  return existsSync(join(path, 'state.json'));
}

async function loadBundle(source: string): Promise<IrBundle> {
  let raw = source;
  let irPath: string | null = null;
  if (raw.startsWith('kimi:')) raw = raw.slice('kimi:'.length);
  if (raw.endsWith('.json') && !isKimiDir(raw)) irPath = raw;
  else if (isKimiDir(raw)) return readKimiBundle(resolve(raw));
  else if (existsSync(raw) && raw.endsWith('.json')) irPath = raw;
  else fail('无法识别的 source: ' + source + '（既不是 Kimi 会话目录也不是 IR json）');

  const text = readFileSync(irPath as string, 'utf8');
  const bundle = JSON.parse(text) as IrBundle;
  const errors = validateIrBundle(bundle);
  if (errors.length > 0) fail('IR 校验失败:\n  ' + errors.join('\n  '));
  return bundle;
}

function printNotices(notices: IrNotice[], indent = '  '): void {
  if (notices.length === 0) return;
  process.stdout.write('notices:\n');
  for (const n of notices) {
    process.stdout.write(indent + '[' + n.severity + '] ' + n.code + ' x' + (n.count ?? 1) + ' — ' + n.message + '\n');
  }
}

function summarize(bundle: IrBundle): string {
  const lines: string[] = [];
  lines.push('IR v' + bundle.irVersion + '  sessions=' + (1 + bundle.children.length) + '  events=' + bundleEventCount(bundle));
  lines.push(summarizeBundle(bundle));
  lines.push('root kinds: ' + JSON.stringify(eventKindCounts(bundle.root)));
  for (const child of bundle.children) {
    lines.push('child kinds(' + child.session.id + '): ' + JSON.stringify(eventKindCounts(child.session)));
  }
  lines.push('');
  lines.push('root source: ' + JSON.stringify(bundle.root.source));
  lines.push('root meta:   ' + JSON.stringify(bundle.root.meta));
  return lines.join('\n');
}

async function cmdInspect(source: string): Promise<void> {
  const bundle = await loadBundle(source);
  process.stdout.write(summarize(bundle) + '\n');
  printNotices(bundle.root.notices);
  for (const child of bundle.children) printNotices(child.session.notices);
}

async function cmdPull(source: string, out: string | undefined): Promise<void> {
  const bundle = await loadBundle(source);
  const body = JSON.stringify(bundle, null, 2);
  if (out) {
    writeFileSync(out, body + '\n', 'utf8');
    process.stdout.write('IR 已写入 ' + resolve(out) + '（' + bundleEventCount(bundle) + ' 事件）\n');
  } else {
    process.stdout.write(body + '\n');
  }
}

async function cmdPush(
  source: string,
  values: Record<string, string | boolean | undefined>,
): Promise<void> {
  const to = typeof values.to === 'string' ? values.to : 'claude-code';
  if (to !== 'claude-code') fail('暂不支持目标 agent: ' + to + '（当前只有 claude-code）');

  const bundle = await loadBundle(source);
  if (typeof values['write-ir'] === 'string') {
    writeFileSync(values['write-ir'] as string, JSON.stringify(bundle, null, 2) + '\n', 'utf8');
  }

  const report = await writeClaudeSession(bundle, {
    configDir: typeof values['config-dir'] === 'string' ? values['config-dir'] : undefined,
    cwd: typeof values.cwd === 'string' ? values.cwd : undefined,
    sessionId: typeof values['session-id'] === 'string' ? values['session-id'] : undefined,
    model: typeof values.model === 'string' ? values.model : undefined,
    version: typeof values.version === 'string' ? values.version : undefined,
    keepThinking: Boolean(values['keep-thinking']),
    dryRun: Boolean(values['dry-run']),
  });

  process.stdout.write(printWriteReport(report) + '\n');
  printNotices(bundle.root.notices);
  process.stdout.write('\n下一步:\n');
  process.stdout.write('  CLAUDE_CONFIG_DIR=' + (typeof values['config-dir'] === 'string' ? values['config-dir'] : '<默认>') +
    ' claude --resume ' + report.sessionId + '\n');
  process.stdout.write('  或直接跑无头验证: node packages/cli/src/index.ts verify --config-dir ' +
    (typeof values['config-dir'] === 'string' ? values['config-dir'] : '<默认>') +
    ' --cwd ' + report.cwd + ' --session-id ' + report.sessionId + ' --resume\n');
}

async function cmdVerify(values: Record<string, string | boolean | undefined>): Promise<void> {
  const cwd = values.cwd;
  const sessionId = values['session-id'];
  if (typeof cwd !== 'string' || typeof sessionId !== 'string') fail('verify 需要 --cwd 和 --session-id');
  const report = await verifyClaudeSession({
    configDir: typeof values['config-dir'] === 'string' ? values['config-dir'] : undefined,
    cwd,
    sessionId,
  });
  process.stdout.write('file: ' + report.filePath + '\nrows: ' + report.rows + '（对话行 ' + report.conversationRows + '）\n');
  for (const check of report.checks) {
    process.stdout.write('  ' + (check.ok ? 'PASS' : 'FAIL') + '  ' + check.name + (check.detail ? '  (' + check.detail + ')' : '') + '\n');
  }
  process.stdout.write(report.ok ? '结构化校验通过\n' : '结构化校验失败\n');

  if (values.resume) {
    process.stdout.write('\n无头 resume 冒烟测试…\n');
    const smoke = await resumeSmoke({
      configDir: typeof values['config-dir'] === 'string' ? values['config-dir'] : undefined,
      cwd,
      sessionId,
    });
    process.stdout.write('command: ' + smoke.command + '\n');
    process.stdout.write('exit: ' + String(smoke.exitCode) + (smoke.timedOut ? ' (timeout)' : '') + '\n');
    if (smoke.stdout) process.stdout.write('stdout: ' + smoke.stdout.trim().slice(0, 1500) + '\n');
    if (smoke.stderr) process.stdout.write('stderr: ' + smoke.stderr.trim().slice(0, 1500) + '\n');
    process.stdout.write(smoke.ok ? 'RESUME SMOKE: PASS\n' : 'RESUME SMOKE: FAIL\n');
    if (!smoke.ok) process.exit(2);
  }
  if (!report.ok) process.exit(2);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(USAGE + '\n');
    return;
  }

  const rest = argv.slice(1);
  const parsed = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      to: { type: 'string' },
      out: { type: 'string' },
      'config-dir': { type: 'string' },
      cwd: { type: 'string' },
      'session-id': { type: 'string' },
      model: { type: 'string' },
      version: { type: 'string' },
      'keep-thinking': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      'write-ir': { type: 'string' },
      resume: { type: 'boolean' },
    },
  });

  switch (command) {
    case 'inspect': {
      const source = parsed.positionals[0];
      if (!source) fail('inspect 需要 <source>');
      await cmdInspect(source);
      return;
    }
    case 'pull': {
      const source = parsed.positionals[0];
      if (!source) fail('pull 需要 <source>');
      await cmdPull(source, typeof parsed.values.out === 'string' ? parsed.values.out : undefined);
      return;
    }
    case 'push': {
      const source = parsed.positionals[0];
      if (!source) fail('push 需要 <source>');
      await cmdPush(source, parsed.values);
      return;
    }
    case 'verify': {
      await cmdVerify(parsed.values);
      return;
    }
    default:
      process.stdout.write(USAGE + '\n');
      fail('未知命令: ' + command);
  }
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});