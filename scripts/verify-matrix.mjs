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
 *      - 系统 pty 耗尽（expect 报 "no more ptys"）是环境问题：等 5 秒重试，最多 3 次；
 *        仍失败就把该 pair 的 native 标 skip（detail 以 "env: no more ptys" 开头），不算产品失败
 *
 * 源会话来源（PAIRS[].source）：
 *   - 默认用写死的 id/path（pin），行为与旧版一致；
 *   - pin 的会话被清理/过期（inspect 解析不到）时，自动为该 pair 挑一个「最新且合格」的会话：
 *       根会话（非子代理）+ 未归档 + updatedAt 在 --max-age-days 天内 + cwd 是存在的目录
 *       + inspect 可解析且 root 事件数 >= --min-events（claude 源还要求 transcript 落在 cwd 对应的
 *       project 目录，即 claude --resume 按 id 能找得到）
 *   - 挑不到就把这对标成 skip 并写明原因，绝不静默失败/误判；
 *   - 实际使用的 source 与选择理由写进 .tmp/matrix/results.json 每行的 source 字段，
 *     终端汇总表用 pinned / auto / skip 标出来源模式。
 *
 * 用法:
 *   node scripts/verify-matrix.mjs           # 全部
 *   node scripts/verify-matrix.mjs claude-dsh dsh-claude   # 只跑指定 pair
 *   node scripts/verify-matrix.mjs --sources-only           # 只解析/打印源选择结果（不 push、不写 results.json）
 *   node scripts/verify-matrix.mjs --no-auto               # 关掉自动兜底（pin 不可用直接 skip）
 *   node scripts/verify-matrix.mjs --min-events=20 --max-age-days=30 --max-candidates=10
 *   node scripts/verify-matrix.mjs claude-commandcode --command-code-smoke   # 会真实调用一次模型（Command Code）
 */
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const MATRIX = join(ROOT, '.tmp', 'matrix');
const CLI = join(ROOT, 'packages', 'cli', 'src', 'index.ts');
const DSH_APP = '/Applications/DeepSeek Harness.app';
const CURSOR_COPY_HOME = join(ROOT, '.tmp', 'cursor-app-test');

/** 源端前缀 → sessionport list 的 agent 名（见 README 的 Sources 一节） */
const SOURCE_AGENT_BY_PREFIX = {
  kimi: 'kimi-code',
  claude: 'claude-code',
  commandcode: 'command-code',
  dsh: 'dsh',
  codex: 'codex',
  opencode: 'opencode',
  cursor: 'cursor',
  qoder: 'qoder',
  workbuddy: 'workbuddy',
};

/** 自动兜底挑选的默认门槛（CLI 可覆盖） */
const AUTO_DEFAULTS = { auto: true, minEvents: 20, maxAgeDays: 30, maxCandidates: 10, sourcesOnly: false, commandCodeSmoke: false };

/** list 每轮最多取多少条：够覆盖「最近若干天」的候选，也避免一次扫描过重 */
const LIST_LIMIT = 200;

/** 每个源端的会话列表只跑一次 CLI（同一次矩阵里多对共用） */
const listCache = new Map();

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
    source: 'dsh:session-fa31c98c-ca1c-4fd9-9646-c07c8e55928a',
    to: 'claude-code',
    children: true,
    cwd: '/Users/lyaqanyi/Documents/deepseek-harness/default-workspace',
    expectText: 'dsh-market',
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
    source: 'codex:01a18820-027c-7da2-98b9-c39e7e57748a',
    to: 'claude-code',
    children: false,
    cwd: '/Users/lyaqanyi/Documents/Codex/2026-10-29/new-chat',
    expectText: '求职',
    native: 'claude',
  },
  {
    id: 'claude-opencode',
    source: 'claude:4402912c-5c81-4696-a2c6-3743e09914c8',
    to: 'opencode',
    children: false,
    cwd: '/Users/lyaqanyi/Documents/Coding/LyaQanYi.com',
    native: 'opencode',
  },
  {
    id: 'claude-codex',
    source: 'claude:4402912c-5c81-4696-a2c6-3743e09914c8',
    to: 'codex',
    children: false,
    cwd: '/Users/lyaqanyi/Documents/Coding/LyaQanYi.com',
    native: 'codex',
  },
  {
    id: 'claude-commandcode',
    source: 'claude:4402912c-5c81-4696-a2c6-3743e09914c8',
    to: 'command-code',
    children: false,
    cwd: '/Users/lyaqanyi/Documents/Coding/LyaQanYi.com',
    native: 'commandcode',
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
    id: 'kimi-claude',
    source: 'kimi:/Users/lyaqanyi/.kimi-code/sessions/wd_lyaqanyi_7b9b29a35e1f/session_708071d1-cdf5-4c8b-99d9-11f040e18417',
    to: 'claude-code',
    children: false,
    cwd: '/Users/lyaqanyi',
    expectText: '卸载 dsh-TUI',
    native: 'claude',
  },
  {
    id: 'kimi-dsh',
    source: 'kimi:/Users/lyaqanyi/.kimi-code/sessions/wd_lyaqanyi_7b9b29a35e1f/session_708071d1-cdf5-4c8b-99d9-11f040e18417',
    to: 'dsh',
    children: false,
    cwd: '/Users/lyaqanyi',
    native: 'dsh',
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
    ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
  });
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error === undefined ? undefined : result.error.message,
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

function fail(message) {
  process.stderr.write('错误: ' + message + '\n');
  process.exit(1);
}

/** 解析 CLI：位置参数是 pair id，-- 开头的是自动挑选的调参 */
function parseCli(argv) {
  const pairIds = [];
  const options = { ...AUTO_DEFAULTS };
  const numberOptions = { '--min-events': 'minEvents', '--max-age-days': 'maxAgeDays', '--max-candidates': 'maxCandidates' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--no-auto') {
      options.auto = false;
      continue;
    }
    if (arg === '--sources-only') {
      options.sourcesOnly = true;
      continue;
    }
    if (arg === '--command-code-smoke') {
      options.commandCodeSmoke = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const equals = arg.indexOf('=');
      const name = equals >= 0 ? arg.slice(0, equals) : arg;
      const key = numberOptions[name];
      if (key === undefined) fail('未知选项: ' + name + '（支持 --no-auto / --sources-only / --command-code-smoke / --min-events / --max-age-days / --max-candidates）');
      const raw = equals >= 0 ? arg.slice(equals + 1) : argv[index + 1];
      if (raw === undefined) fail(name + ' 需要一个正整数');
      if (equals < 0) index += 1;
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed <= 0) fail(name + ' 需要正整数，收到: ' + raw);
      options[key] = parsed;
      continue;
    }
    pairIds.push(arg);
  }
  return { pairIds, options };
}

/** 'claude:<路径|id>' → { prefix, agent, key }；无法识别的 source（例如 IR 文件）返回 undefined */
function parseSourceSpec(spec) {
  const colon = spec.indexOf(':');
  if (colon <= 0) return undefined;
  const prefix = spec.slice(0, colon).toLowerCase();
  const agent = SOURCE_AGENT_BY_PREFIX[prefix];
  if (agent === undefined) return undefined;
  return { prefix, agent, key: spec.slice(colon + 1) };
}

function firstLine(text) {
  const line = String(text ?? '').split('\n').map((item) => item.trim()).find((item) => item.length > 0);
  return line ?? '';
}

/** cwd 必须是真实存在的绝对目录，否则目标端 native 加载会从错的工作目录启动 */
function usableCwd(cwd) {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) return false;
  try {
    return statSync(cwd).isDirectory();
  } catch {
    return false;
  }
}

/** 与 core 的 claudeProjectSlug 一致：claude --resume 按 <projects>/<slug(cwd)>/<id>.jsonl 查找 */
function claudeProjectSlug(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/gu, '-');
}

/** claude 源额外校验：transcript 必须落在 cwd 对应的 project 目录，否则 claude --resume 找不到 */
function claudeResumeLookupOk(nativePath, cwd) {
  if (typeof nativePath !== 'string' || !existsSync(nativePath)) return false;
  return basename(dirname(nativePath)) === claudeProjectSlug(cwd);
}

/** 源端会话列表（按 agent 缓存；失败也只记一次，不阻断其它 pair） */
function listedSessions(agent) {
  const cached = listCache.get(agent);
  if (cached !== undefined) return cached;
  const result = run(process.execPath, [CLI, 'list', '--agent', agent, '--json', '--limit', String(LIST_LIMIT)], { timeoutMs: 120_000 });
  const parsed = parseJson(result.stdout);
  const sessions = Array.isArray(parsed?.sessions) ? parsed.sessions : [];
  const entry = { sessions, error: undefined };
  if (!Array.isArray(parsed?.sessions)) {
    entry.error = 'list 失败（exit ' + result.code + '）：' + (firstLine(result.stderr) || firstLine(result.stdout) || result.error || '无输出');
  }
  listCache.set(agent, entry);
  return entry;
}

/** 跑一次 inspect，解析 root 事件数 / cwd / 标题；同时保留原始输出（用于匹配 expectText） */
function inspectSource(source) {
  const result = run(process.execPath, [CLI, 'inspect', source], { timeoutMs: 180_000 });
  if (result.code !== 0) {
    const raw = firstLine(result.stderr) || firstLine(result.stdout) || result.error || 'inspect 失败（exit ' + result.code + '）';
    return { ok: false, error: raw.replace(/^错误:\s*/u, '') };
  }
  const match = /^root\s+(\S+)\s+events=(\d+)(?:\s+cwd=(.*))?$/mu.exec(result.stdout);
  if (match === undefined) return { ok: false, error: 'inspect 输出无法解析（缺少 root 行）' };
  const rootId = match[1];
  const colon = rootId.indexOf(':');
  const titleMatch = /^ {2}title=(.*)$/mu.exec(result.stdout);
  const title = titleMatch === undefined ? undefined : titleMatch[1].split('  model=')[0].trim();
  return {
    ok: true,
    rootId,
    sessionId: colon >= 0 ? rootId.slice(colon + 1) : rootId,
    events: Number(match[2]),
    cwd: match[3] === undefined ? undefined : match[3].trim(),
    title: title === undefined || title.length === 0 ? undefined : title,
    text: result.stdout,
  };
}

/** auto 挑选时怎么把候选写回 source 形式（各家接受的输入不同，见 README Sources） */
function autoSourceSpec(prefix, session) {
  // opencode/cursor 只接受会话 id；claude 用 id（与 pin 形式一致，另有 project 目录校验兜底）；
  // 其余用 nativePath 更精确（codex 的 rollout 文件名 id 与 session_meta id 可能不同，用路径才不会认错会话）
  if (prefix === 'opencode' || prefix === 'cursor' || prefix === 'claude') {
    return typeof session.sessionId === 'string' && session.sessionId.length > 0 ? prefix + ':' + session.sessionId : undefined;
  }
  if (typeof session.nativePath !== 'string' || session.nativePath.length === 0) return undefined;
  return prefix + ':' + session.nativePath;
}

function skippedSource(pair, reason, extra = {}) {
  return { mode: 'skip', configured: pair.source, used: undefined, reason, ...extra };
}

/** 表格里只放一句短原因；完整原因在 source.reason / results.json */
function shortSkipReason(source) {
  const raw = String(source.reason ?? '').replace(/^skip:\s*/u, '');
  return raw.length <= 140 ? raw : raw.slice(0, 137) + '…';
}

/**
 * 自动挑一个「最新且合格」的源会话（list 已按 updatedAt 倒序，所以第一个合格的就是最新的）。
 * 合格 = 根会话（非子代理）+ 未归档 + N 天内更新 + cwd 是存在的目录 + inspect 可解析且 root 事件数 >= M；
 * claude 源额外要求 transcript 在 cwd 对应的 project 目录（claude --resume 能找到）。
 */
function pickAutoSource(pair, parsed, pinnedError, options) {
  const listed = listedSessions(parsed.agent);
  if (listed.error !== undefined) {
    return skippedSource(pair, 'skip: 硬编码源不可用（' + pinnedError + '）；auto 也失败：' + listed.error);
  }
  const now = Date.now();
  const maxAgeMs = options.maxAgeDays * 24 * 60 * 60 * 1000;
  const pool = listed.sessions.filter((session) => session.parentSessionId === undefined && session.archived !== true);
  const fresh = pool.filter((session) => {
    const updated = Date.parse(session.updatedAt ?? '');
    return Number.isFinite(updated) && now - updated <= maxAgeMs;
  });
  // 显式按 updatedAt 倒序，不依赖 list 的排序实现：「最新且合格」里的最新必须是本脚本自己算的
  const withCwd = fresh
    .filter((session) => usableCwd(session.cwd))
    .sort((left, right) => Date.parse(right.updatedAt ?? '') - Date.parse(left.updatedAt ?? ''));
  const candidates = withCwd.slice(0, options.maxCandidates);
  const diagnostics =
    '列表 ' + listed.sessions.length + ' 条 → 根会话 ' + pool.length + ' → ' + options.maxAgeDays + ' 天内 ' + fresh.length + ' → cwd 可用 ' + withCwd.length;
  const rejections = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const spec = autoSourceSpec(parsed.prefix, candidate);
    if (spec === undefined) {
      rejections.push(candidate.sessionId + ': 无法构造 source 形式');
      continue;
    }
    const inspected = inspectSource(spec);
    if (!inspected.ok) {
      rejections.push(candidate.sessionId + ': inspect 失败（' + inspected.error + '）');
      continue;
    }
    if (inspected.events < options.minEvents) {
      rejections.push(candidate.sessionId + ': events=' + inspected.events + ' < ' + options.minEvents);
      continue;
    }
    const cwd = inspected.cwd ?? candidate.cwd;
    if (!usableCwd(cwd)) {
      rejections.push(candidate.sessionId + ': cwd 不可用（' + String(cwd) + '）');
      continue;
    }
    if (parsed.prefix === 'claude' && !claudeResumeLookupOk(candidate.nativePath, cwd)) {
      rejections.push(candidate.sessionId + ': transcript 不在 cwd 对应的 project 目录（claude --resume 会找不到）');
      continue;
    }
    const ageDays = Math.floor((now - Date.parse(candidate.updatedAt ?? '')) / (24 * 60 * 60 * 1000));
    const expectMatched = pair.expectText !== undefined && inspected.text.includes(pair.expectText);
    const reason =
      'auto: newest ' + parsed.prefix + ' session with >=' + options.minEvents + ' events, ' + String(candidate.updatedAt ?? '').slice(0, 10) +
      '（events=' + inspected.events + ', age=' + ageDays + 'd, 候选 ' + (index + 1) + '/' + candidates.length + '）' +
      (expectMatched ? '; 标题命中 expectText "' + pair.expectText + '"' : '');
    return {
      mode: 'auto',
      configured: pair.source,
      used: spec,
      sourceAgent: parsed.agent,
      sessionId: candidate.sessionId,
      nativePath: candidate.nativePath,
      events: inspected.events,
      updatedAt: candidate.updatedAt,
      title: candidate.title ?? inspected.title,
      pinnedError,
      reason,
      inspected: rejections.slice(),
    };
  }
  const detail =
    rejections.length === 0
      ? '没有可检查的候选'
      : '检查 ' + rejections.length + ' 个均不合格：' + rejections.slice(0, 4).join('；') + (rejections.length > 4 ? ' …' : '');
  return skippedSource(pair, 'skip: 硬编码源不可用（' + pinnedError + '）；auto 未找到合格 ' + parsed.prefix + ' 会话 [' + diagnostics + '；' + detail + ']', {
    inspected: rejections.slice(),
  });
}

/** 解析每对实际使用的 source：pin 优先；pin 不可用才自动挑；都拿不到就 skip（带原因） */
function resolvePairSource(pair, options) {
  const configured = pair.source;
  const parsed = parseSourceSpec(configured);
  const pinned = inspectSource(configured);
  if (pinned.ok) {
    const below = pinned.events < options.minEvents;
    return {
      mode: 'pinned',
      configured,
      used: configured,
      sourceAgent: parsed === undefined ? undefined : parsed.agent,
      sessionId: pinned.sessionId,
      nativePath: undefined,
      events: pinned.events,
      updatedAt: undefined,
      title: pinned.title,
      reason:
        'pinned: 硬编码源存在，直接使用（events=' + pinned.events + '）' +
        (below ? '（低于 auto 阈值 ' + options.minEvents + '，但 pin 优先）' : ''),
    };
  }
  const pinnedError = pinned.error;
  if (!options.auto) {
    return skippedSource(pair, 'skip: 硬编码源不可用（' + pinnedError + '），且 --no-auto 禁止自动挑选');
  }
  if (parsed === undefined) {
    return skippedSource(pair, 'skip: 硬编码源不可用（' + pinnedError + '），且 source 形式无法识别源端 agent，不能自动挑选');
  }
  return pickAutoSource(pair, parsed, pinnedError, options);
}

/** 目标端各自报的版本号；矩阵结果要能回答“对哪个版本验的” */
function toolVersions() {
  const cliVersion = (command) => {
    const result = run(command, ['--version']);
    const line = (result.stdout + result.stderr)
      .split('\n')
      .map((text) => text.trim())
      .find((text) => text.length > 0 && !/WARNING/i.test(text));
    return line;
  };
  const appVersion = (appPath) => {
    const result = run('defaults', ['read', join(appPath, 'Contents', 'Info.plist'), 'CFBundleShortVersionString']);
    return result.code === 0 ? result.stdout.trim() : undefined;
  };
  return {
    claude: cliVersion('claude'),
    codex: cliVersion('codex'),
    opencode: cliVersion('opencode'),
    cursor: appVersion('/Applications/Cursor.app'),
    qoder: appVersion('/Applications/Qoder CN.app'),
    dsh: appVersion('/Applications/DeepSeek Harness.app'),
    workbuddy: appVersion('/Applications/WorkBuddy.app'),
    kimi: cliVersion('kimi'),
  };
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
  const capture = () => {
    // 先删掉上一轮残留：否则 expect 起不来时会拿旧日志当本轮结果（既可能误判 pass，也认不出 pty 耗尽）
    rmSync(logPath, { force: true });
    const result = run(
      'expect',
      [join(ROOT, 'scripts', 'claude-tui-capture.exp'), pair.report.sessionId, tuiCwd, logPath],
      { env: { CLAUDE_CONFIG_DIR: homePath } },
    );
    return {
      stderr: result.stderr ?? '',
      logText: existsSync(logPath) ? readFileSync(logPath, 'utf8') : '',
    };
  };
  // 系统 pty 被占满时 expect 起不来（"no more ptys"）。这是环境问题而非产品失败：
  // 等 5 秒重试，最多 3 次；仍失败就把 native 标 skip（detail 以 "env: no more ptys" 开头），不判 fail。
  const PTY_RETRIES = 3;
  const PTY_WAIT_SECONDS = 5;
  let attempt = capture();
  let ptyFailures = 0;
  while (/no more ptys/i.test(attempt.stderr + attempt.logText)) {
    ptyFailures += 1;
    if (ptyFailures > PTY_RETRIES) {
      return { status: 'skip', detail: 'env: no more ptys（系统 pty 耗尽，重试 ' + PTY_RETRIES + ' 次仍失败；非产品失败）' };
    }
    run('sleep', [String(PTY_WAIT_SECONDS)]);
    attempt = capture();
  }
  if (attempt.logText.length === 0) {
    const hint = firstLine(attempt.stderr);
    return { status: 'fail', detail: 'TUI 日志缺失' + (hint.length > 0 ? '（expect: ' + hint.slice(0, 120) + '）' : '') };
  }
  const clean = stripAnsi(attempt.logText);
  const broken = /No conversation found|Invalid (?:input|session)|Unable to load/i.test(clean);
  const hasContent = clean.length > 400;
  if (broken) return { status: 'fail', detail: 'TUI 报加载错误' };
  if (!hasContent) return { status: 'fail', detail: 'TUI 没有显示会话内容' };
  const signature = pair.expectText !== undefined && clean.includes(pair.expectText);
  const autoNote = pair.sourceSelection?.mode === 'auto' ? '（auto 源：expectText 绑在 pin 源上，此处不作断言）' : '';
  return {
    status: 'pass',
    detail: (signature ? 'claude --resume 打开并显示预期内容' : 'claude --resume 打开并显示会话内容（标题未出现在抓屏区域）') + autoNote,
  };
}

function nativeDshCheck(pair, homePath) {
  const cli = join(DSH_APP, 'Contents', 'Resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
  const bin = join(DSH_APP, 'Contents', 'MacOS', 'DeepSeek Harness');
  const logPath = join(MATRIX, pair.id + '.dsh-load.log');
  const child = spawn(bin, ['--expose-internals', cli, 'headless', '--json', '--session-id', pair.report.sessionId, 'hi'], {
    cwd: pair.report?.cwd ?? pair.cwd,
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

const COMMAND_CODE_APP = '/Applications/Command Code.app';
const COMMAND_CODE_CLI = join(COMMAND_CODE_APP, 'Contents', 'Resources', 'app', 'node_modules', 'command-code', 'dist', 'index.mjs');
const COMMAND_CODE_STORE = join(homedir(), '.commandcode');
/** CLI 只认 ~/.commandcode：把真实凭据复制进 .tmp 的隔离 HOME，避免写用户目录（沙箱也会拦） */
const COMMAND_CODE_HOME_FILES = ['auth.json', 'config.json', 'models-cache.json', 'telemetry-install-id', 'zero-data-retention.json'];

/**
 * Command Code 原生加载：让打包在桌面端里的 CLI 用无头模式 resume 这份 transcript。
 *
 * 和 codex 一样，隔离 home 没有凭据时它会在**加载前**就拒绝（Not authenticated），
 * 所以这里复制真实凭据到 .tmp；若凭据有效会真实调用一次模型，因此默认关闭，
 * 只有 --command-code-smoke 才跑。看到 run_start / turn_start 即算加载成功。
 */
function nativeCommandCodeCheck(pair, options) {
  if (options.commandCodeSmoke !== true) {
    return { status: 'skip', detail: '未启用（冒烟会真实调用一次模型；用 --command-code-smoke 开启）' };
  }
  if (!existsSync(COMMAND_CODE_CLI)) {
    return { status: 'skip', detail: 'Command Code CLI 不存在（未安装桌面端）' };
  }
  const file = pair.report?.filePath ?? pair.report?.paths?.[0];
  if (typeof file !== 'string' || !existsSync(file)) {
    return { status: 'fail', detail: '缺少 transcript 路径' };
  }
  const ccHome = join(MATRIX, 'commandcode-home');
  rmSync(ccHome, { recursive: true, force: true });
  mkdirSync(join(ccHome, '.commandcode'), { recursive: true });
  let copied = 0;
  for (const name of COMMAND_CODE_HOME_FILES) {
    const from = join(COMMAND_CODE_STORE, name);
    if (existsSync(from)) {
      copyFileSync(from, join(ccHome, '.commandcode', name));
      copied += 1;
    }
  }
  if (copied === 0) return { status: 'skip', detail: '没有可复制的 Command Code 凭据（先运行一次 cmd login）' };
  return new Promise((resolvePromise) => {
    const child = spawn(
      process.execPath,
      [COMMAND_CODE_CLI, '-p', '--session', file, '--output-format', 'json', '-t', '--skip-onboarding', '--yolo', 'Reply with exactly: RESUME_OK'],
      { cwd: pair.report?.cwd ?? pair.cwd, env: { ...process.env, HOME: ccHome }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const started = /"type":"run_start"/.test(output) || /"type":"turn_start"/.test(output);
      const authBlocked = /401|api key|Authentication failed|Not authenticated/i.test(output);
      if (started) {
        resolvePromise({
          status: 'pass',
          detail: 'command code 无头加载 transcript 并开始 turn' + (authBlocked ? '（凭据失效，模型调用被 401 拦下）' : ''),
        });
      } else {
        const hint = (output.match(/"(?:error|message)":"([^"]{0,160})"/) ?? [])[1] ?? output.slice(0, 160);
        resolvePromise({ status: 'fail', detail: '未出现 run_start/turn_start：' + hint });
      }
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish();
    }, 120_000);
    child.on('exit', finish);
    child.on('error', finish);
  });
}

function nativeOpencodeCheck(pair, homePath) {
  const exported = run('opencode', ['export', pair.report.sessionId], {
    env: { XDG_DATA_HOME: homePath },
    cwd: pair.report?.cwd ?? pair.cwd,
  });
  const start = exported.stdout.indexOf('{');
  if (start < 0) return { status: 'fail', detail: 'opencode export 没有 JSON 输出' };
  let parsed;
  try {
    parsed = JSON.parse(exported.stdout.slice(start));
  } catch {
    return { status: 'fail', detail: 'opencode export JSON 解析失败' };
  }
  const infoId = parsed?.info?.id;
  const messages = Array.isArray(parsed?.messages) ? parsed.messages.length : 0;
  if (infoId === pair.report.sessionId && messages > 0) {
    return { status: 'pass', detail: 'opencode export 读回 ' + messages + ' 条消息' };
  }
  return { status: 'fail', detail: 'export 内容不匹配（id=' + String(infoId) + ' messages=' + messages + '）' };
}

function nativeCodexCheck(pair, homePath) {
  const sid = pair.report.sessionId;
  return new Promise((resolvePromise) => {
    const child = spawn('codex', ['exec', 'resume', '--skip-git-repo-check', sid, '--json', 'hi'], {
      cwd: pair.report?.cwd ?? pair.cwd,
      env: { ...process.env, CODEX_HOME: homePath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const started = /"type":"thread\.started"/.test(output) && output.includes(sid);
      const turn = /"type":"turn\.started"/.test(output);
      const authBlocked = /401|Missing bearer|Unauthorized/i.test(output);
      if (started) {
        resolvePromise({
          status: 'pass',
          detail:
            'codex exec resume 载入 thread' +
            (turn ? ' 并开始 turn' : '') +
            (authBlocked ? '（隔离 home 无凭据，模型调用被 401 拦下）' : ''),
        });
      } else {
        resolvePromise({ status: 'fail', detail: 'codex 未发出 thread.started' });
      }
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish();
    }, 25_000);
    child.on('exit', finish);
    child.on('error', finish);
  });
}

async function runPair(pair, options) {
  // 源会话：pin 优先；pin 被清理/过期时自动挑最新合格会话；挑不到就 skip（不 push、不误判）
  const source = resolvePairSource(pair, options);
  if (source.mode === 'skip') {
    return {
      pair,
      source,
      written: undefined,
      structural: { status: 'skip', detail: shortSkipReason(source) },
      native: { status: 'skip', detail: '源会话不可用，未执行原生加载' },
    };
  }
  const homePath = join(MATRIX, pair.id + '-home');
  rmSync(homePath, { recursive: true, force: true });
  mkdirSync(homePath, { recursive: true });
  const targetHome = pair.to === 'cursor' ? CURSOR_COPY_HOME : homePath;
  const pushArgs = [CLI, 'push', source.used, '--to', pair.to, '--json'];
  if (pair.to === 'dsh') pushArgs.push('--home', targetHome, '--register', '--compact');
  else if (pair.to === 'claude-code') pushArgs.push('--config-dir', targetHome);
  else if (pair.to === 'qoder') pushArgs.push('--home', targetHome);
  else if (pair.to === 'opencode') pushArgs.push('--home', targetHome);
  else if (pair.to === 'codex') pushArgs.push('--home', targetHome);
  else if (pair.to === 'command-code') pushArgs.push('--home', targetHome);
  else if (pair.to === 'cursor') pushArgs.push('--home', targetHome, '--confirm-real', '--title', '[sessionport 矩阵] ' + pair.id);
  if (pair.children) pushArgs.push('--include-children');
  const pushed = run(process.execPath, pushArgs);
  const report = parseJson(pushed.stdout + pushed.stderr);
  if (pushed.code !== 0 || report === undefined) {
    return { pair, source, written: undefined, structural: { status: 'fail', detail: 'push 失败' }, native: { status: 'skip', detail: pushed.stderr.slice(0, 200) } };
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
  } else if (pair.to === 'opencode') {
    const verified = run(process.execPath, [CLI, 'verify', '--agent', 'opencode', '--home', targetHome, '--id', report.sessionId]);
    structural = summarizeVerify(verified.stdout);
  } else if (pair.to === 'codex') {
    const file = report.filePath || report.paths?.[0];
    const verified = run(process.execPath, [CLI, 'verify', '--agent', 'codex', '--file', file]);
    structural = summarizeVerify(verified.stdout);
  } else if (pair.to === 'command-code') {
    const file = report.filePath || report.paths?.[0];
    const verified = run(process.execPath, [CLI, 'verify', '--agent', 'command-code', '--file', file]);
    structural = summarizeVerify(verified.stdout);
  } else {
    const verified = run(process.execPath, [CLI, 'verify', '--agent', 'cursor', '--home', targetHome, '--id', report.composerId]);
    structural = summarizeVerify(verified.stdout);
  }

  let native;
  if (pair.native === 'claude') {
    seedClaudeHome(homePath, report.cwd ?? pair.cwd);
    native = nativeClaudeCheck({ ...pair, report, sourceSelection: source }, homePath);
  }
  else if (pair.native === 'dsh') native = await nativeDshCheck({ ...pair, report, sourceSelection: source }, homePath);
  else if (pair.native === 'opencode') native = nativeOpencodeCheck({ ...pair, report, sourceSelection: source }, homePath);
  else if (pair.native === 'codex') native = await nativeCodexCheck({ ...pair, report, sourceSelection: source }, homePath);
  else if (pair.native === 'commandcode') native = await nativeCommandCodeCheck({ ...pair, report, sourceSelection: source }, options);
  else if (pair.native === 'sdk') native = { status: 'manual', detail: 'Qoder 桌面无本地入口；SDK listSubagents/getSubagentMessages 已单独验证' };
  else native = { status: 'manual', detail: 'Cursor 无 headless；diff 卡片已人工验证' };

  return { pair, source, report, written: report.written, structural, native };
}

function summarizeVerify(text) {
  const pass = (text.match(/PASS/g) ?? []).length;
  const fail = (text.match(/FAIL/g) ?? []).length;
  return { status: fail === 0 && pass > 0 ? 'pass' : 'fail', detail: pass + ' PASS / ' + fail + ' FAIL' };
}

const cli = parseCli(process.argv.slice(2));
const only = cli.pairIds;
const options = cli.options;
const selected = only.length > 0 ? PAIRS.filter((pair) => only.includes(pair.id)) : PAIRS;
if (only.length > 0 && selected.length === 0) {
  fail('未知 pair: ' + only.join(', ') + '（可选 ' + PAIRS.map((pair) => pair.id).join(' / ') + '）');
}
mkdirSync(MATRIX, { recursive: true });
if (options.sourcesOnly) {
  console.log('源选择预演（只读；pin 优先，pin 不可用时 auto，不合格标 skip）：');
  for (const pair of selected) {
    const source = resolvePairSource(pair, options);
    console.log('\n- ' + pair.id + '  [' + source.mode + ']');
    console.log('  configured: ' + pair.source);
    console.log('  used      : ' + (source.used ?? '-'));
    console.log('  reason    : ' + source.reason);
    for (const rejection of source.inspected ?? []) console.log('  拒选: ' + rejection);
  }
  process.exit(0);
}
const versions = toolVersions();
writeFileSync(join(MATRIX, 'versions.json'), JSON.stringify(versions, null, 2));
const previousResults = (() => {
  try {
    const parsed = JSON.parse(readFileSync(join(MATRIX, 'results.json'), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
})();
const ran = [];
for (const pair of selected) {
  process.stderr.write('→ ' + pair.id + ' ... ');
  const result = await runPair(pair, options);
  process.stderr.write(result.structural.status + '/' + result.native.status + ' (' + (result.source?.mode ?? '?') + ')\n');
  if (result.source?.mode === 'auto') process.stderr.write('   auto 源: ' + result.source.used + ' — ' + result.source.reason + '\n');
  if (result.source?.mode === 'skip') process.stderr.write('   skip 原因: ' + result.source.reason + '\n');
  ran.push(result);
}
const pairOrder = new Map(PAIRS.map((pair, index) => [pair.id, index]));
const results = (only.length > 0
  ? [...previousResults.filter((row) => row?.pair?.id && !ran.some((fresh) => fresh.pair.id === row.pair.id)), ...ran]
  : ran
).sort((left, right) => (pairOrder.get(left.pair.id) ?? 99) - (pairOrder.get(right.pair.id) ?? 99));
writeFileSync(join(MATRIX, 'results.json'), JSON.stringify(results, null, 2));

const rows = results.map((result) => {
  const written = result.report?.written;
  return {
    pair: result.pair.id,
    source: result.source?.mode ?? '-',
    events: written?.events ?? 0,
    structural: result.structural.status + ' (' + result.structural.detail + ')',
    native: result.native.status + ' (' + result.native.detail + ')',
  };
});
console.log('\n目标端版本: ' + Object.entries(versions).map(([name, version]) => name + '=' + (version ?? '?')).join(', '));
console.log('\n| pair | 源 | events | 结构校验 | 原生加载 |');
console.log('|---|---|---|---|---|');
for (const row of rows) console.log('| ' + row.pair + ' | ' + row.source + ' | ' + row.events + ' | ' + row.structural + ' | ' + row.native + ' |');

const skipped = results.filter((result) => result.source?.mode === 'skip' || result.structural?.status === 'skip');
if (skipped.length > 0) {
  console.log('\n⚠️ 跳过 ' + skipped.length + ' 对（pin 不可用且 auto 没挑到合格会话）：' + skipped.map((result) => result.pair.id).join(', '));
}
const envSkipped = results.filter(
  (result) => result.native?.status === 'skip' && /no more ptys/i.test(String(result.native?.detail ?? '')),
);
if (envSkipped.length > 0) {
  console.log(
    '\n⚠️ env 跳过原生加载 ' + envSkipped.length + ' 对（系统 pty 耗尽，不是产品失败，可空闲后重跑）：' +
    envSkipped.map((result) => result.pair.id).join(', '),
  );
}
console.log('\n源选择（与 .tmp/matrix/results.json 每行的 source 字段一致）：');
for (const result of results) {
  const source = result.source ?? {};
  console.log(
    '- ' + result.pair.id + ': ' + (source.mode ?? '-') +
    ' | source=' + (source.used ?? result.pair.source ?? '-') +
    ' | ' + (source.reason ?? '历史结果（无 source 记录）'),
  );
}
