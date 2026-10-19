#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { bundleEventCount, describeDecision, eventKindCounts, findRef, loadRegistry, planSync, saveRegistry, sourceKeyOf, upsertRef, validateIrBundle } from '@sessionport/core';
import type { ExternalRef, SyncDecision } from '@sessionport/core';
import type { IrBundle, IrNotice } from '@sessionport/core';

const USAGE = [
  'sessionport — 在 AI 编程 agent 之间搬运会话',
  '',
  '用法:',
  '  sessionport inspect <source>',
  '  sessionport pull <source> [--out ir.json]',
  '  sessionport push <source> --to <agent> [options]',
  '  sessionport sync <source> --to <agent> [options]   # 安全重推：不覆盖目标端新增内容',
  '  sessionport verify --agent <agent> [options]',
  '',
  '<source> 形式:',
  '  kimi:<目录>            Kimi Code 会话目录（kimi export 解包目录或原生会话目录）',
  '  commandcode:<路径>     Command Code transcript（.jsonl）或会话 id',
  '  dsh:<目录>             DSH 会话目录（含 session.v4.jsonl.zstd）',
  '  <ir.json>              已有 IR 文件',
  '  <无前缀目录/文件>      按结构自动识别',
  '',
  '目标 agent（--to）:',
  '  claude-code  |  command-code  |  dsh',
  '',
  '通用选项:',
  '  --home <dir>           目标数据根目录（claude: 配置目录；command-code: ~/.commandcode；dsh: DSH_HOME）',
  '  --cwd <dir>            目标会话的工作目录（默认取源会话 cwd）',
  '  --id <id>              指定目标会话 id',
  '  --model <name>         目标模型名',
  '  --title <text>         目标会话标题',
  '  --dry-run              只生成不落盘',
  '  --register             写完顺带注册进目标 app：dsh 写 workspace.json，command-code 写 thread-index.db + app-state.json',
  '  --user-data-dir <dir>  command-code 桌面端数据目录覆盖（默认 ~/Library/Application Support/Command Code）',
  '  --write-ir <file>      同时把 IR 落盘',
  '  --json                 输出机器可读 JSON',
  '  --force                sync: 目标端有新增时仍然覆盖（会丢目标端新内容）',
  '  --fork                 sync: 目标端有新增时另建一个目标会话，保留旧会话',
  '  --state <dir>          registry 目录（默认 $SESSIONPORT_HOME 或 ~/.sessionport）',
  '',
  'claude-code 专属:',
  '  --config-dir <dir>     --home 的别名；--version <ver>；--keep-thinking（thinking 降级为 text）',
  '',
  'verify 选项:',
  '  --agent <agent>        要校验的目标 agent',
  '  --file <path>          command-code 的 transcript 路径',
  '  --resume               额外跑一次无头 resume（claude-code / command-code，会真实调用模型）',
].join('\n');

function fail(message: string): never {
  process.stderr.write('错误: ' + message + '\n');
  process.exit(1);
}

interface SourceKind {
  kind: 'kimi' | 'command-code' | 'dsh' | 'ir';
  target: string;
}

function detectSource(raw: string): SourceKind {
  if (raw.startsWith('kimi:')) return { kind: 'kimi', target: raw.slice(5) };
  if (raw.startsWith('commandcode:')) return { kind: 'command-code', target: raw.slice(12) };
  if (raw.startsWith('cmd:')) return { kind: 'command-code', target: raw.slice(4) };
  if (raw.startsWith('dsh:')) return { kind: 'dsh', target: raw.slice(4) };
  if (raw.endsWith('.json') && existsSync(raw) && !existsSync(join(raw, 'state.json'))) return { kind: 'ir', target: raw };
  if (existsSync(join(raw, 'state.json'))) return { kind: 'kimi', target: raw };
  if (existsSync(join(raw, 'session.v4.jsonl.zstd'))) return { kind: 'dsh', target: raw };
  if (raw.endsWith('.jsonl.zstd')) return { kind: 'dsh', target: raw };
  if (raw.endsWith('.jsonl')) return { kind: 'command-code', target: raw };
  if (existsSync(raw) && existsSync(join(raw, 'agents'))) return { kind: 'kimi', target: raw };
  fail('无法识别的 source: ' + raw + '（可以显式加 kimi: / commandcode: / dsh: 前缀）');
}

async function loadBundle(source: string): Promise<IrBundle> {
  const detected = detectSource(source);
  if (detected.kind === 'ir') {
    const bundle = JSON.parse(readFileSync(detected.target, 'utf8')) as IrBundle;
    const errors = validateIrBundle(bundle);
    if (errors.length > 0) fail('IR 校验失败:\n  ' + errors.join('\n  '));
    return bundle;
  }
  if (detected.kind === 'kimi') {
    const mod = await import('@sessionport/adapter-kimi-code');
    return mod.readKimiBundle(resolve(detected.target));
  }
  if (detected.kind === 'command-code') {
    const mod = await import('@sessionport/adapter-command-code');
    return mod.readCommandCodeSession(detected.target);
  }
  const mod = await import('@sessionport/adapter-dsh');
  return mod.readDshSession(detected.target);
}

function printNotices(notices: IrNotice[]): void {
  if (notices.length === 0) return;
  process.stdout.write('notices:\n');
  for (const n of notices) {
    process.stdout.write('  [' + n.severity + '] ' + n.code + ' x' + (n.count ?? 1) + ' — ' + n.message + '\n');
  }
}

function summarize(bundle: IrBundle): string {
  const lines: string[] = [];
  lines.push('IR v' + bundle.irVersion + '  sessions=' + (1 + bundle.children.length) + '  events=' + bundleEventCount(bundle));
  lines.push('root ' + bundle.root.id + '  events=' + bundle.root.events.length + '  cwd=' + (bundle.root.meta.cwd ?? '?'));
  lines.push('  title=' + (bundle.root.meta.title ?? '(none)') + '  model=' + (bundle.root.meta.model ?? '?'));
  lines.push('root kinds: ' + JSON.stringify(eventKindCounts(bundle.root)));
  for (const child of bundle.children) {
    lines.push('child ' + child.session.id + '  events=' + child.session.events.length + '  label=' + (child.label ?? '?'));
  }
  lines.push('root source: ' + JSON.stringify(bundle.root.source));
  return lines.join('\n');
}

function commonTargetOptions(values: Record<string, string | boolean | undefined>): Record<string, unknown> {
  return {
    home: typeof values.home === 'string' ? values.home : typeof values['config-dir'] === 'string' ? values['config-dir'] : undefined,
    cwd: typeof values.cwd === 'string' ? values.cwd : undefined,
    id: typeof values.id === 'string' ? values.id : typeof values['session-id'] === 'string' ? values['session-id'] : undefined,
    model: typeof values.model === 'string' ? values.model : undefined,
    title: typeof values.title === 'string' ? values.title : undefined,
    registerWorkspace: Boolean(values.register),
    register: Boolean(values.register),
    keepInjected: Boolean(values['keep-injected']),
    userDataDir: typeof values['user-data-dir'] === 'string' ? values['user-data-dir'] : undefined,
    dryRun: Boolean(values['dry-run']),
  };
}

function printReport(report: {
  target: string;
  sessionId: string;
  paths: string[];
  written?: { events: number; messages: number; toolCalls: number; toolResults: number; reasoning: number };
  losses?: Array<{ severity: string; code: string; count: number; message: string }>;
}): void {
  process.stdout.write('target      ' + report.target + '\n');
  process.stdout.write('session     ' + report.sessionId + '\n');
  for (const p of report.paths) process.stdout.write('path        ' + p + '\n');
  if (report.written) {
    process.stdout.write(
      'written     events=' + report.written.events +
        ' messages=' + report.written.messages +
        ' tool_calls=' + report.written.toolCalls +
        ' tool_results=' + report.written.toolResults +
        ' reasoning=' + report.written.reasoning + '\n',
    );
  }
  const losses = report.losses ?? [];
  process.stdout.write('losses      ' + (losses.length === 0 ? 'none' : '') + '\n');
  for (const loss of losses) process.stdout.write('  [' + loss.severity + '] ' + loss.code + ' x' + loss.count + ' — ' + loss.message + '\n');
}

async function cmdPush(source: string, values: Record<string, string | boolean | undefined>): Promise<void> {
  const to = typeof values.to === 'string' ? values.to : '';
  if (!to) fail('push 需要 --to <agent>（claude-code / command-code / dsh）');
  const bundle = await loadBundle(source);
  if (typeof values['write-ir'] === 'string') {
    writeFileSync(values['write-ir'] as string, JSON.stringify(bundle, null, 2) + '\n', 'utf8');
  }
  const opts = commonTargetOptions(values);

  let report: Parameters<typeof printReport>[0];
  if (to === 'claude-code') {
    const mod = await import('@sessionport/adapter-claude-code');
    report = await mod.writeClaudeSession(bundle, {
      configDir: opts.home as string | undefined,
      cwd: opts.cwd as string | undefined,
      sessionId: opts.id as string | undefined,
      model: opts.model as string | undefined,
      version: typeof values.version === 'string' ? values.version : undefined,
      keepThinking: Boolean(values['keep-thinking']),
      dryRun: Boolean(values['dry-run']),
    });
  } else if (to === 'command-code') {
    const mod = await import('@sessionport/adapter-command-code');
    report = await mod.writeCommandCodeSession(bundle, opts);
  } else if (to === 'dsh') {
    const mod = await import('@sessionport/adapter-dsh');
    report = await mod.writeDshSession(bundle, opts);
  } else {
    fail('不支持的目标 agent: ' + to);
  }

  if (values.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return;
  }
  printReport(report);
  printNotices(bundle.root.notices);
  process.stdout.write('\n下一步: 用目标 agent 打开/继续这个会话（' + report.paths[0] + '）\n');
}

interface WriteOutcome {
  target: string;
  targetId: string;
  paths: string[];
  /** 目标端计量单位（rows: transcript 行数含头；events: 事件数） */
  unit: 'rows' | 'events';
  units: number;
  report: { written?: { events: number }; rows?: unknown[]; losses?: Array<{ severity: string; code: string; count: number; message: string }> };
}

async function writeTarget(
  target: string,
  bundle: IrBundle,
  opts: Record<string, unknown>,
  id: string | undefined,
  dryRun: boolean,
): Promise<WriteOutcome> {
  if (target === 'claude-code') {
    const mod = await import('@sessionport/adapter-claude-code');
    const report = await mod.writeClaudeSession(bundle, {
      ...(opts as object),
      sessionId: id,
      dryRun,
    });
    return { target, targetId: report.sessionId, paths: report.paths, unit: 'rows', units: report.rows.length, report };
  }
  if (target === 'command-code') {
    const mod = await import('@sessionport/adapter-command-code');
    const report = await mod.writeCommandCodeSession(bundle, { ...(opts as object), id, dryRun });
    return { target, targetId: report.sessionId, paths: report.paths, unit: 'rows', units: report.rows.length + 1, report };
  }
  const mod = await import('@sessionport/adapter-dsh');
  const report = await mod.writeDshSession(bundle, { ...(opts as object), id, dryRun });
  return { target, targetId: report.sessionId, paths: report.paths, unit: 'events', units: report.written.events, report };
}

async function countTarget(target: string, outcome: WriteOutcome, opts: Record<string, unknown>): Promise<{ exists: boolean; units: number }> {
  if (target === 'command-code') {
    const mod = await import('@sessionport/adapter-command-code');
    return mod.countCommandCodeTarget(outcome.paths[0]!);
  }
  if (target === 'dsh') {
    const mod = await import('@sessionport/adapter-dsh');
    const result = await mod.countDshTarget({ home: opts.home as string | undefined, sessionId: outcome.targetId });
    return { exists: result.exists, units: result.units };
  }
  try {
    const text = readFileSync(outcome.paths[0]!, 'utf8');
    return { exists: true, units: text.split('\n').filter((line) => line.trim().length > 0).length };
  } catch {
    return { exists: false, units: 0 };
  }
}

async function cmdSync(source: string, values: Record<string, string | boolean | undefined>): Promise<void> {
  const to = typeof values.to === 'string' ? values.to : '';
  if (!to) fail('sync 需要 --to <agent>（claude-code / command-code / dsh）');
  const bundle = await loadBundle(source);
  const opts = commonTargetOptions(values);
  const stateHome = typeof values.state === 'string' ? values.state : undefined;
  const registry = loadRegistry(stateHome);
  const sourceKey = sourceKeyOf(bundle.root.source, bundle.root.id);
  const ref: ExternalRef | undefined = findRef(registry, sourceKey, to as never);

  // 用 dry-run 先算出「如果现在写，会写到哪、有多少单位」
  const preview = await writeTarget(to, bundle, opts, ref?.targetId ?? (typeof opts.id === 'string' ? opts.id : undefined), true);
  const current = await countTarget(to, preview, opts);

  const decision: SyncDecision = planSync({
    ref,
    source: { head: bundle.root.head, events: bundle.root.events.length },
    target: { exists: current.exists, units: current.units },
  });

  process.stdout.write('source      ' + sourceKey + '  events=' + bundle.root.events.length + '  head=' + (bundle.root.head ?? '-') + '\n');
  process.stdout.write('target      ' + to + (ref ? '  id=' + ref.targetId : '') + '\n');
  process.stdout.write('decision    ' + describeDecision(decision) + '\n');

  const diverged = decision.kind === 'diverged';
  const force = Boolean(values.force);
  const fork = Boolean(values.fork);
  if (diverged && !force && !fork) {
    process.stderr.write(
      '\n拒绝写入：目标端在上次同步后新增了 ' + decision.targetExtra + ' 单位。\n' +
      '  --fork   另建目标会话，保留旧会话（推荐）\n' +
      '  --force  直接覆盖（目标端新增内容会丢）\n',
    );
    process.exit(2);
  }
  if (decision.kind === 'up-to-date') {
    process.stdout.write('没有写入。\n');
    return;
  }

  const useFork = diverged && fork;
  const targetId = useFork ? undefined : (ref?.targetId ?? (typeof opts.id === 'string' ? opts.id : undefined));
  if (useFork) process.stdout.write('fork      为当前源快照新建目标会话（旧会话保持不动）\n');

  const outcome = await writeTarget(to, bundle, opts, targetId, false);
  printReport(outcome.report as Parameters<typeof printReport>[0]);
  printNotices(bundle.root.notices);

  const nextRef: ExternalRef = {
    sourceKey,
    target: to as never,
    targetId: outcome.targetId,
    targetPath: resolve(outcome.paths[0]!),
    unit: outcome.unit,
    targetUnits: outcome.units,
    sourceEvents: bundle.root.events.length,
    sourceHead: bundle.root.head,
    updatedAt: new Date().toISOString(),
  };
  upsertRef(registry, nextRef);
  const registryFile = saveRegistry(registry, stateHome);
  process.stdout.write('\nregistry    ' + registryFile + '\n');
  process.stdout.write('已记录同步状态：sourceHead=' + (nextRef.sourceHead ?? '-') + ' sourceEvents=' + nextRef.sourceEvents + ' targetUnits=' + nextRef.targetUnits + '\n');
}

async function cmdVerify(values: Record<string, string | boolean | undefined>): Promise<void> {
  const agent = typeof values.agent === 'string' ? values.agent : '';
  if (!agent) fail('verify 需要 --agent（claude-code / command-code / dsh）');
  const opts = commonTargetOptions(values);

  let result: { ok: boolean; checks: Array<{ name: string; ok: boolean; detail?: string }> };
  if (agent === 'claude-code') {
    const mod = await import('@sessionport/adapter-claude-code');
    const cwd = opts.cwd;
    const id = opts.id;
    if (typeof cwd !== 'string' || typeof id !== 'string') fail('claude-code 校验需要 --cwd 和 --id');
    const report = await mod.verifyClaudeSession({ configDir: opts.home as string | undefined, cwd, sessionId: id });
    result = { ok: report.ok, checks: report.checks };
    process.stdout.write('file: ' + report.filePath + '\nrows: ' + report.rows + '\n');
  } else if (agent === 'command-code') {
    const mod = await import('@sessionport/adapter-command-code');
    const file = typeof values.file === 'string' ? values.file : String(opts.id ?? '');
    if (!file) fail('command-code 校验需要 --file 或 --id');
    const report = await mod.verifyCommandCodeSession({ filePath: file });
    result = { ok: report.ok, checks: report.checks };
  } else {
    const mod = await import('@sessionport/adapter-dsh');
    const id = opts.id;
    if (typeof id !== 'string') fail('dsh 校验需要 --id');
    const report = await mod.verifyDshSession({ home: opts.home as string | undefined, sessionId: id });
    result = { ok: report.ok, checks: report.checks };
  }

  for (const check of result.checks) {
    process.stdout.write('  ' + (check.ok ? 'PASS' : 'FAIL') + '  ' + check.name + (check.detail ? '  (' + check.detail + ')' : '') + '\n');
  }
  process.stdout.write(result.ok ? '结构化校验通过\n' : '结构化校验失败\n');

  if (values.resume) {
    if (agent === 'claude-code') {
      const mod = await import('@sessionport/adapter-claude-code');
      process.stdout.write('\n无头 resume 冒烟测试…\n');
      const smoke = await mod.resumeSmoke({
        configDir: opts.home as string | undefined,
        cwd: String(opts.cwd),
        sessionId: String(opts.id),
      });
      process.stdout.write('command: ' + smoke.command + '\n');
      process.stdout.write(smoke.ok ? 'RESUME SMOKE: PASS\n' : 'RESUME SMOKE: FAIL\n');
      if (!smoke.ok) process.exit(2);
    } else if (agent === 'command-code') {
      const mod = await import('@sessionport/adapter-command-code');
      if (typeof mod.resumeSmokeCommandCode !== 'function') fail('该 adapter 还没有提供 resumeSmokeCommandCode');
      process.stdout.write('\n无头 resume 冒烟测试…\n');
      const smoke = await mod.resumeSmokeCommandCode({ filePath: typeof values.file === 'string' ? values.file : undefined });
      process.stdout.write('command: ' + smoke.command + '\n');
      if (smoke.stdout) process.stdout.write('stdout: ' + String(smoke.stdout).slice(-1200) + '\n');
      if (smoke.stderr) process.stdout.write('stderr: ' + String(smoke.stderr).slice(-1200) + '\n');
      process.stdout.write(smoke.ok ? 'RESUME SMOKE: PASS\n' : 'RESUME SMOKE: FAIL\n');
      if (!smoke.ok) process.exit(2);
    } else {
      const mod = await import('@sessionport/adapter-dsh');
      process.stdout.write('\nDSH headless resume 冒烟测试…\n');
      const home = mod.dshHome(typeof opts.home === 'string' ? opts.home : undefined);
      // 会话记录在源 cwd 下；headless CLI 会校验 cwd，必须跟着会话走
      let sessionCwd = typeof opts.cwd === 'string' ? opts.cwd : undefined;
      if (sessionCwd === undefined) {
        try {
          const bundle = await mod.readDshSession(String(opts.id), { home });
          sessionCwd = bundle.root.meta.cwd;
        } catch {
          sessionCwd = undefined;
        }
      }
      const smoke = await mod.resumeSmokeDsh({ home, sessionId: String(opts.id), cwd: sessionCwd });
      process.stdout.write('command: ' + smoke.command + '\n');
      process.stdout.write('loaded=' + String((smoke as { loaded?: boolean }).loaded) +
        ' turnStarted=' + String((smoke as { turnStarted?: boolean }).turnStarted) +
        ' missingCredential=' + String((smoke as { missingCredential?: boolean }).missingCredential) + '\n');
      if (smoke.stdout) process.stdout.write('stdout: ' + String(smoke.stdout).slice(-1500) + '\n');
      if (smoke.stderr) process.stdout.write('stderr: ' + String(smoke.stderr).slice(-1500) + '\n');
      process.stdout.write(smoke.ok ? 'RESUME SMOKE: PASS\n' : 'RESUME SMOKE: FAIL\n');
      if (!smoke.ok) process.exit(2);
    }
  }
  if (!result.ok) process.exit(2);
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
      agent: { type: 'string' },
      file: { type: 'string' },
      home: { type: 'string' },
      'config-dir': { type: 'string' },
      cwd: { type: 'string' },
      id: { type: 'string' },
      'session-id': { type: 'string' },
      model: { type: 'string' },
      title: { type: 'string' },
      version: { type: 'string' },
      'keep-thinking': { type: 'boolean' },
      'keep-injected': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      register: { type: 'boolean' },
      'user-data-dir': { type: 'string' },
      'write-ir': { type: 'string' },
      resume: { type: 'boolean' },
      force: { type: 'boolean' },
      fork: { type: 'boolean' },
      state: { type: 'string' },
      json: { type: 'boolean' },
    },
  });
  const values = parsed.values as Record<string, string | boolean | undefined>;
  const positionals = parsed.positionals;

  if (command === 'inspect') {
    const source = positionals[0];
    if (!source) fail('inspect 需要 <source>');
    const bundle = await loadBundle(source);
    process.stdout.write(summarize(bundle) + '\n');
    printNotices(bundle.root.notices);
    for (const child of bundle.children) printNotices(child.session.notices);
    return;
  }
  if (command === 'pull') {
    const source = positionals[0];
    if (!source) fail('pull 需要 <source>');
    const bundle = await loadBundle(source);
    const body = JSON.stringify(bundle, null, 2);
    if (typeof values.out === 'string') {
      writeFileSync(values.out, body + '\n', 'utf8');
      process.stdout.write('IR 已写入 ' + resolve(values.out) + '（' + bundleEventCount(bundle) + ' 事件）\n');
    } else {
      process.stdout.write(body + '\n');
    }
    return;
  }
  if (command === 'push') {
    const source = positionals[0];
    if (!source) fail('push 需要 <source>');
    await cmdPush(source, values);
    return;
  }
  if (command === 'sync') {
    const source = positionals[0];
    if (!source) fail('sync 需要 <source>');
    await cmdSync(source, values);
    return;
  }
  if (command === 'verify') {
    await cmdVerify(values);
    return;
  }
  process.stdout.write(USAGE + '\n');
  fail('未知命令: ' + command);
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});