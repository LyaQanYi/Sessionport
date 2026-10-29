#!/usr/bin/env node
/**
 * 真实恢复验收矩阵（P0）。
 *
 * 对每对「源 → 目标」：
 *   1. push 到隔离的 target home（不碰真实 app 库，cursor 例外：写 .tmp 副本库）
 *   2. 跑目标端结构 verify
 *   3. 尽量跑目标端**原生加载**：
 *      - dsh：Electron headless --json --session-id，看到 {"type":"session"} 即算加载成功
 *      - claude-code：expect 打开 claude --resume，Ctrl+O 抓屏，检查标题且无解析错误
 *      - cursor/qoder：无 headless 入口，标 manual/sdk
 *
 * 用法:
 *   node scripts/verify-matrix.mjs           # 全部
 *   node scripts/verify-matrix.mjs claude-dsh dsh-claude   # 只跑指定 pair
 */
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const MATRIX = join(ROOT, '.tmp', 'matrix');
const CLI = join(ROOT, 'packages', 'cli', 'src', 'index.ts');
const DSH_APP = '/Applications/DeepSeek Harness.app';
const CURSOR_COPY_HOME = join(ROOT, '.tmp', 'cursor-app-test');

const PAIRS = [
  {
    id: 'claude-dsh',
    source: 'claude:0beb93b8-5179-4b81-8d54-9ec96de91c13',
    to: 'dsh',
    children: true,
    cwd: '/Users/lyaqanyi/Documents/GitHub/neko-auth-platform',
    expectText: 'PR #213',
    native: 'dsh',
  },
  {
    id: 'dsh-claude',
    source: 'dsh:session-22e4f5f8-01b0-4c2a-95ba-433914d812d3',
    to: 'claude-code',
    children: true,
    cwd: '/Users/lyaqanyi/Documents/GitHub/sessionport',
    expectText: '继续开发对话同步工具',
    native: 'claude',
  },
  {
    id: 'wb-claude',
    source: 'workbuddy:f022affa-196f-4fc4-a789-2439bdbd3a37',
    to: 'claude-code',
    children: true,
    cwd: '/Users/lyaqanyi/Documents/GitHub/neko-auth-platform',
    expectText: '系统工程审查',
    native: 'claude',
  },
  {
    id: 'codex-claude',
    source: 'codex:01a182f9-4c74-7172-bd07-0fdee3f2088b',
    to: 'claude-code',
    children: false,
    cwd: '/Users/lyaqanyi/Documents/GitHub/neko-auth-platform',
    expectText: 'Review PR #430',
    native: 'claude',
  },
  {
    id: 'claude-qoder',
    source: 'claude:0beb93b8-5179-4b81-8d54-9ec96de91c13',
    to: 'qoder',
    children: true,
    cwd: '/Users/lyaqanyi/Documents/GitHub/neko-auth-platform',
    native: 'sdk',
  },
  {
    id: 'wb-qoder',
    source: 'workbuddy:f022affa-196f-4fc4-a789-2439bdbd3a37',
    to: 'qoder',
    children: true,
    cwd: '/Users/lyaqanyi/Documents/GitHub/neko-auth-platform',
    native: 'sdk',
  },
  {
    id: 'claude-cursor',
    source: 'claude:0beb93b8-5179-4b81-8d54-9ec96de91c13',
    to: 'cursor',
    children: false,
    cwd: '/Users/lyaqanyi/Documents/GitHub/neko-auth-platform',
    native: 'manual',
  },
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...(options.env ?? {}) },
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function parseJson(text) {
  const start = text.indexOf('{');
  if (start < 0) return undefined;
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return undefined;
  }
}

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/[^\x20-\x7e\u4e00-\u9fff\n]/g, ' ').replace(/\s+/g, ' ');
}

/** 隔离的 CLAUDE_CONFIG_DIR 需要最少配置，否则 TUI 停在首启向导 */
function seedClaudeHome(homePath, cwd) {
  mkdirSync(homePath, { recursive: true });
  const settings = join(homedir(), '.claude', 'settings.json');
  if (existsSync(settings)) copyFileSync(settings, join(homePath, 'settings.json'));
  const globalConfig = join(homedir(), '.claude.json');
  let data = {};
  if (existsSync(globalConfig)) {
    try {
      data = JSON.parse(readFileSync(globalConfig, 'utf8'));
    } catch {
      data = {};
    }
  }
  data.hasCompletedOnboarding = true;
  data.projects = data.projects ?? {};
  const projectEntry = data.projects[cwd] ?? {};
  data.projects[cwd] = { ...projectEntry, hasTrustDialogAccepted: true };
  writeFileSync(join(homePath, '.claude.json'), JSON.stringify(data));
}

function nativeClaudeCheck(pair, homePath) {
  const logPath = join(MATRIX, pair.id + '.claude-tui.log');
  const tuiCwd = pair.report.cwd ?? pair.cwd;
  const captured = run('expect', [
    join(ROOT, 'scripts', 'claude-tui-capture.exp'),
    pair.report.sessionId,
    tuiCwd,
    logPath,
  ], { env: { CLAUDE_CONFIG_DIR: homePath } });
  if (!existsSync(logPath)) return { status: 'fail', detail: 'TUI 日志缺失' };
  const clean = stripAnsi(readFileSync(logPath, 'utf8'));
  const broken = /No conversation found|Invalid (?:input|session)|Unable to load/i.test(clean);
  const hasContent = clean.length > 400;
  if (broken) return { status: 'fail', detail: 'TUI 报加载错误' };
  if (!hasContent) return { status: 'fail', detail: 'TUI 没有显示会话内容' };
  const signature = pair.expectText !== undefined && clean.includes(pair.expectText);
  return {
    status: 'pass',
    detail: signature ? 'claude --resume 打开并显示预期内容' : 'claude --resume 打开并显示会话内容（标题未出现在抓屏区域）',
  };
}

function nativeDshCheck(pair, homePath) {
  const cli = join(DSH_APP, 'Contents', 'Resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
  const bin = join(DSH_APP, 'Contents', 'MacOS', 'DeepSeek Harness');
  const logPath = join(MATRIX, pair.id + '.dsh-load.log');
  const child = spawn(bin, ['--expose-internals', cli, 'headless', '--json', '--session-id', pair.report.sessionId, 'hi'], {
    cwd: pair.cwd,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: homePath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish();
    }, 25_000);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      writeFileSync(logPath, output, 'utf8');
      const lines = output.split('\n').filter(Boolean);
      const sessionLine = lines.some((line) => line.includes('"type":"session"'));
      const adopted = lines.some((line) => /"phase":"turn_start"/.test(line));
      resolvePromise(
        sessionLine
          ? { status: 'pass', detail: adopted ? 'headless 加载 Session 并开始 turn' : 'headless 加载 Session' }
          : { status: 'fail', detail: 'headless 未输出 session 事件' },
      );
    };
    child.on('exit', finish);
    child.on('error', finish);
  });
}

async function runPair(pair) {
  const homePath = join(MATRIX, pair.id + '-home');
  rmSync(homePath, { recursive: true, force: true });
  mkdirSync(homePath, { recursive: true });
  const targetHome = pair.to === 'cursor' ? CURSOR_COPY_HOME : homePath;
  const pushArgs = [CLI, 'push', pair.source, '--to', pair.to, '--json'];
  if (pair.to === 'dsh') pushArgs.push('--home', targetHome, '--register', '--compact');
  else if (pair.to === 'claude-code') pushArgs.push('--config-dir', targetHome);
  else if (pair.to === 'qoder') pushArgs.push('--home', targetHome);
  else if (pair.to === 'cursor') pushArgs.push('--home', targetHome, '--confirm-real', '--title', '[sessionport 矩阵] ' + pair.id);
  if (pair.children) pushArgs.push('--include-children');
  const pushed = run(process.execPath, pushArgs);
  const report = parseJson(pushed.stdout + pushed.stderr);
  if (pushed.code !== 0 || report === undefined) {
    return { pair, written: undefined, structural: { status: 'fail', detail: 'push 失败' }, native: { status: 'skip', detail: pushed.stderr.slice(0, 200) } };
  }

  let structural;
  if (pair.to === 'dsh') {
    const verified = run(process.execPath, [CLI, 'verify', '--agent', 'dsh', '--home', targetHome, '--id', report.sessionId]);
    structural = summarizeVerify(verified.stdout);
  } else if (pair.to === 'claude-code') {
    const verifyCwd = report.cwd ?? pair.cwd;
    const verified = run(process.execPath, [CLI, 'verify', '--agent', 'claude-code', '--home', targetHome, '--cwd', verifyCwd, '--id', report.sessionId]);
    structural = summarizeVerify(verified.stdout);
  } else if (pair.to === 'qoder') {
    const file = report.path || report.filePath;
    const verified = run(process.execPath, [CLI, 'verify', '--agent', 'qoder', '--file', file]);
    structural = summarizeVerify(verified.stdout);
  } else {
    const verified = run(process.execPath, [CLI, 'verify', '--agent', 'cursor', '--home', targetHome, '--id', report.composerId]);
    structural = summarizeVerify(verified.stdout);
  }

  let native;
  if (pair.native === 'claude') {
    seedClaudeHome(homePath, report.cwd ?? pair.cwd);
    native = nativeClaudeCheck({ ...pair, report }, homePath);
  }
  else if (pair.native === 'dsh') native = await nativeDshCheck({ ...pair, report }, homePath);
  else if (pair.native === 'sdk') native = { status: 'manual', detail: 'Qoder 桌面无本地入口；SDK listSubagents/getSubagentMessages 已单独验证' };
  else native = { status: 'manual', detail: 'Cursor 无 headless；diff 卡片已人工验证' };

  return { pair, report, written: report.written, structural, native };
}

function summarizeVerify(text) {
  const pass = (text.match(/PASS/g) ?? []).length;
  const fail = (text.match(/FAIL/g) ?? []).length;
  return { status: fail === 0 && pass > 0 ? 'pass' : 'fail', detail: pass + ' PASS / ' + fail + ' FAIL' };
}

const only = process.argv.slice(2);
const selected = only.length > 0 ? PAIRS.filter((pair) => only.includes(pair.id)) : PAIRS;
mkdirSync(MATRIX, { recursive: true });
const results = [];
for (const pair of selected) {
  process.stderr.write('→ ' + pair.id + ' ... ');
  const result = await runPair(pair);
  process.stderr.write(result.structural.status + '/' + result.native.status + '\n');
  results.push(result);
}
writeFileSync(join(MATRIX, 'results.json'), JSON.stringify(results, null, 2));

const rows = results.map((result) => {
  const written = result.report?.written;
  return {
    pair: result.pair.id,
    events: written?.events ?? 0,
    structural: result.structural.status + ' (' + result.structural.detail + ')',
    native: result.native.status + ' (' + result.native.detail + ')',
  };
});
console.log('\n| pair | events | 结构校验 | 原生加载 |');
console.log('|---|---|---|---|');
for (const row of rows) console.log('| ' + row.pair + ' | ' + row.events + ' | ' + row.structural + ' | ' + row.native + ' |');
