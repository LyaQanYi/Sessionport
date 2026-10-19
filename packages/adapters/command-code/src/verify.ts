import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { basename, dirname, resolve } from 'node:path';

import { isCcEntry, isCcHeader, parseJsonl } from './wire.ts';
import type { CcBlock, CcEntry, CcMessageEntry } from './wire.ts';
import { listCommandCodeSessions } from './read.ts';

export interface VerifyCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface VerifyReport {
  ok: boolean;
  filePath: string;
  /** 文件里的 JSON 行数（含 session 头） */
  rows: number;
  /** message entry 数 */
  conversationRows: number;
  checks: VerifyCheck[];
}

export interface VerifyCommandCodeOptions {
  /** transcript 路径；也允许直接给会话 id（CLI 的 --id 兜底） */
  filePath: string;
  /** 按 id 解析时的数据根目录，默认 ~/.commandcode */
  home?: string;
}

const ALLOWED_BLOCK_TYPES = new Set(['text', 'thinking', 'tool_use', 'tool_result', 'image']);

function blocksOf(entry: CcEntry): CcBlock[] {
  if (entry.type !== 'message') return [];
  const content = (entry as CcMessageEntry).message?.content;
  return Array.isArray(content) ? content : [];
}

function resultIdsOf(entry: CcEntry): string[] {
  return blocksOf(entry)
    .filter((block) => block.type === 'tool_result')
    .map((block) => (block as { tool_use_id?: string }).tool_use_id ?? '')
    .filter((id) => id.length > 0);
}

function useIdsOf(entry: CcEntry): string[] {
  return blocksOf(entry)
    .filter((block) => block.type === 'tool_use')
    .map((block) => (block as { id?: string }).id ?? '')
    .filter((id) => id.length > 0);
}

/**
 * Command Code transcript 结构自检（不依赖目标 CLI）。
 *
 * 检查项对齐 CLI 源码的加载路径（parseV3Lines / buildSessionPath / createSessionRecorder）：
 * - 首行必须是合法 session 头（isSessionHeaderV3）
 * - entry 形状、id 唯一、parentId 链完整
 * - 每个 tool_use 都有配对 tool_result，且没有孤立 tool_result
 * - content block 类型在白名单内
 * - 每条 message 带 messageId（缺了会导致 resume 时旧消息被重复 append，实测）
 * - 无关行容忍：无法识别的行不会让自检失败（CLI 把它们当 corrupted 丢弃），只记入 detail
 */
export async function verifyCommandCodeSession(options: VerifyCommandCodeOptions): Promise<VerifyReport> {
  let filePath = resolve(options.filePath);
  const checks: VerifyCheck[] = [];
  if (!existsSync(filePath) && !options.filePath.includes('/')) {
    // 像会话 id 而不是路径：在数据根目录里按 id / 前缀解析
    try {
      const sessions = await listCommandCodeSessions({ home: options.home });
      const exact = sessions.filter((session) => session.id === options.filePath);
      const matches = exact.length > 0 ? exact : sessions.filter((session) => session.id.startsWith(options.filePath));
      if (matches.length === 1) filePath = matches[0]!.path;
      else if (matches.length > 1) {
        checks.push({ name: 'session-id-ambiguous', ok: false, detail: matches.map((session) => session.id).join(', ') });
      }
    } catch {
      // 解析失败就按路径处理，后面 file-exists 会给出明确失败
    }
  }
  const exists = existsSync(filePath);
  checks.push({ name: 'file-exists', ok: exists, detail: filePath });
  if (!exists) return { ok: false, filePath, rows: 0, conversationRows: 0, checks };

  const raw = await readFile(filePath, 'utf8');
  const parsed = parseJsonl(raw);
  checks.push({ name: 'jsonl-parses', ok: parsed.badLines === 0, detail: '无法解析 ' + parsed.badLines + ' 行' });
  checks.push({ name: 'has-content', ok: parsed.lines.length > 0, detail: parsed.lines.length + ' 行' });

  const header = parsed.records[0];
  const headerOk = header !== undefined && isCcHeader(header);
  checks.push({ name: 'header-valid', ok: headerOk, detail: headerOk ? 'v' + (header as { version: number }).version : '首行不是合法 session 头' });

  const entries: CcEntry[] = [];
  let invalidEntries = 0;
  for (const record of parsed.records.slice(1)) {
    if (isCcEntry(record)) entries.push(record);
    else invalidEntries += 1;
  }
  checks.push({
    name: 'tolerated-lines',
    ok: true,
    detail: invalidEntries === 0 ? 'ok' : invalidEntries + ' 行不是合法 entry（loader 会按 corrupted 丢弃）',
  });

  const conversationRows = entries.filter((entry) => entry.type === 'message').length;
  checks.push({ name: 'has-conversation-rows', ok: conversationRows > 0, detail: conversationRows + ' 条 message entry' });

  const ids = entries.map((entry) => entry.id);
  const uniqueIds = new Set(ids);
  checks.push({ name: 'ids-unique', ok: uniqueIds.size === ids.length, detail: uniqueIds.size + '/' + ids.length });

  // 严格链：我们写出的文件应当是线性链。但目标 app 自己续写（resume 之后）会产生
  // 悬空 parentId（指向已被压缩/未持久化的记录）或分叉指向更早的记录 —— 这类不影响加载，
  // 因此只把「首行 parentId 非 null / 中间出现 null」算作真正的断链。
  let chainBroken = 0;
  let danglingParents = 0;
  let branchedParents = 0;
  const seenIds = new Set<string>();
  let previous: CcEntry | undefined;
  for (const entry of entries) {
    const expected = previous === undefined ? null : previous.id;
    if (entry.parentId !== expected) {
      if (entry.parentId === null || entry.parentId === undefined) chainBroken += 1;
      else if (seenIds.has(entry.parentId)) branchedParents += 1;
      else danglingParents += 1;
    }
    seenIds.add(entry.id);
    previous = entry;
  }
  const chainDetail = [
    chainBroken + ' 处断链',
    danglingParents > 0 ? danglingParents + ' 处悬空 parentId（目标 app 续写常见，不影响加载）' : '',
    branchedParents > 0 ? branchedParents + ' 处指向更早记录的分叉' : '',
  ].filter((part) => part.length > 0).join('，');
  checks.push({ name: 'parent-chain', ok: chainBroken === 0, detail: chainDetail });

  const badTimestamps = entries.filter((entry) => !Number.isFinite(Date.parse(entry.timestamp)));
  checks.push({ name: 'timestamps-parseable', ok: badTimestamps.length === 0, detail: badTimestamps.length + ' 行时间戳非法' });

  let monotonicBroken = 0;
  let lastMs = Number.NEGATIVE_INFINITY;
  for (const entry of entries) {
    const ms = Date.parse(entry.timestamp);
    if (Number.isFinite(ms)) {
      if (ms < lastMs) monotonicBroken += 1;
      lastMs = Math.max(lastMs, ms);
    }
  }
  checks.push({ name: 'timestamps-monotonic', ok: monotonicBroken === 0, detail: monotonicBroken + ' 处时间倒退' });

  const oddBlocks = entries.flatMap(blocksOf).filter((block) => !ALLOWED_BLOCK_TYPES.has(String((block as { type?: string }).type)));
  checks.push({
    name: 'content-block-types',
    ok: oddBlocks.length === 0,
    detail: oddBlocks.length === 0 ? 'ok' : oddBlocks.map((block) => String((block as { type?: string }).type)).join(','),
  });

  const badMessages = entries.filter((entry) => {
    if (entry.type !== 'message') return false;
    const message = (entry as CcMessageEntry).message;
    return !message || (message.role !== 'user' && message.role !== 'assistant') || !Array.isArray(message.content);
  });
  checks.push({ name: 'message-shape', ok: badMessages.length === 0, detail: badMessages.length + ' 条 message 结构非法' });

  const messageIds: string[] = [];
  let missingMessageId = 0;
  for (const entry of entries) {
    if (entry.type !== 'message') continue;
    const messageId = (entry as CcMessageEntry).message?.meta?.messageId;
    if (typeof messageId !== 'string' || messageId.length === 0) missingMessageId += 1;
    else messageIds.push(messageId);
  }
  checks.push({
    name: 'message-meta-complete',
    ok: missingMessageId === 0,
    detail: missingMessageId === 0 ? 'ok' : missingMessageId + ' 条 message 缺 meta.messageId（resume 时会重复 append 旧消息）',
  });
  checks.push({
    name: 'message-ids-unique',
    ok: new Set(messageIds).size === messageIds.length,
    detail: new Set(messageIds).size + '/' + messageIds.length,
  });

  const uses = new Map<string, number>();
  const results = new Map<string, number>();
  for (const entry of entries) {
    for (const id of useIdsOf(entry)) uses.set(id, (uses.get(id) ?? 0) + 1);
    for (const id of resultIdsOf(entry)) results.set(id, (results.get(id) ?? 0) + 1);
  }
  const missingResults = [...uses.keys()].filter((id) => !results.has(id));
  const orphanResults = [...results.keys()].filter((id) => !uses.has(id));
  checks.push({
    name: 'tool-pairing',
    ok: missingResults.length === 0 && orphanResults.length === 0,
    detail: 'tool_use 缺结果 ' + missingResults.length + '，孤立 tool_result ' + orphanResults.length,
  });

  const metaPath = filePath.endsWith('.jsonl') ? filePath.slice(0, -'.jsonl'.length) + '.meta.json' : filePath + '.meta.json';
  if (existsSync(metaPath)) {
    let metaOk = true;
    let metaDetail = metaPath;
    try {
      const meta = JSON.parse(await readFile(metaPath, 'utf8')) as { entrypoint?: unknown; title?: unknown };
      metaDetail = 'entrypoint=' + String(meta.entrypoint ?? '(none)') + ' title=' + String(meta.title ?? '(none)');
      if (meta.entrypoint === 'print') metaOk = false;
    } catch {
      metaOk = false;
      metaDetail = 'meta.json 不是合法 JSON';
    }
    checks.push({ name: 'meta-sidecar', ok: metaOk, detail: metaDetail });
  } else {
    checks.push({ name: 'meta-sidecar', ok: true, detail: '无 meta.json（resume 可省）' });
  }

  if (headerOk && header !== undefined) {
    const typeHeader = header as { id: string; cwd?: unknown };
    const fileStem = basename(filePath, '.jsonl');
    checks.push({ name: 'header-id-matches-filename', ok: fileStem === typeHeader.id, detail: fileStem + ' vs ' + typeHeader.id });
    checks.push({ name: 'header-cwd', ok: typeof typeHeader.cwd === 'string' && String(typeHeader.cwd).length > 0, detail: String(typeHeader.cwd ?? '') });
  }

  return { ok: checks.every((check) => check.ok), filePath, rows: parsed.records.length, conversationRows, checks };
}

// ---------------------------------------------------------------------------
// 无头 resume 冒烟（会真实调用一次模型；默认不跑）
// ---------------------------------------------------------------------------

export const DEFAULT_CC_CLI = '/Applications/Command Code.app/Contents/Resources/app/node_modules/command-code/dist/index.mjs';

export function commandCodeCliPath(explicit?: string): string | undefined {
  if (explicit && explicit.length > 0) return explicit;
  const fromEnv = process.env.COMMAND_CODE_CLI;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return existsSync(DEFAULT_CC_CLI) ? DEFAULT_CC_CLI : undefined;
}

export interface ResumeSmokeOptions {
  filePath: string;
  prompt?: string;
  /** 期望出现在最终回答里的标记，默认 RESUME_OK */
  expect?: string;
  model?: string;
  cwd?: string;
  cliPath?: string;
  timeoutMs?: number;
}

export interface ResumeSmokeResult {
  ok: boolean;
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cliPath?: string;
}

/**
 * 真正的验收：让 Command Code CLI 无头 resume 这份 transcript。
 * `cmd -p --session <path>` 会把新的一轮 append 回同一个文件，所以只在临时文件上跑。
 */
export function resumeSmokeCommandCode(options: ResumeSmokeOptions): Promise<ResumeSmokeResult> {
  if (typeof options.filePath !== 'string' || options.filePath.length === 0) {
    return Promise.resolve({
      ok: false,
      command: '(missing --file)',
      exitCode: null,
      stdout: '',
      stderr: 'resumeSmokeCommandCode 需要 transcript 路径；CLI 的 verify --resume 请配 --file <path>',
      timedOut: false,
      cliPath: commandCodeCliPath(options.cliPath),
    });
  }
  const filePath = resolve(options.filePath);
  const prompt = options.prompt ?? 'Reply with exactly: RESUME_OK';
  const expect = options.expect ?? 'RESUME_OK';
  const cliPath = commandCodeCliPath(options.cliPath);
  if (!cliPath) {
    return Promise.resolve({
      ok: false,
      command: '(command code cli not found)',
      exitCode: null,
      stdout: '',
      stderr: '找不到 Command Code CLI：设置 COMMAND_CODE_CLI 或安装 Command Code 桌面端',
      timedOut: false,
      cliPath: undefined,
    });
  }
  const args = [
    '-p',
    '--session', filePath,
    '--output-format', 'json',
    '-t',
    '--skip-onboarding',
    '--yolo',
    ...(options.model ? ['-m', options.model] : []),
    prompt,
  ];
  const isScript = cliPath.endsWith('.mjs') || cliPath.endsWith('.js');
  const command = (isScript ? 'node ' : '') + JSON.stringify(cliPath) + ' ' + args.map((arg) => JSON.stringify(arg)).join(' ');
  return new Promise((resolveResult) => {
    const child = isScript
      ? spawn(process.execPath, [cliPath, ...args], { cwd: options.cwd ?? dirname(filePath), stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn(cliPath, args, { cwd: options.cwd ?? dirname(filePath), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs ?? 240000);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const output = stdout + '\n' + stderr;
      resolveResult({
        ok: code === 0 && !timedOut && output.includes(expect),
        command,
        exitCode: code,
        stdout: stdout.slice(-6000),
        stderr: stderr.slice(-4000),
        timedOut,
        cliPath,
      });
    });
  });
}
/** 同步用：统计目标 transcript 的行数（含 session 头）。不存在时 units=0。 */
export async function countCommandCodeTarget(filePath: string): Promise<{ exists: boolean; units: number }> {
  try {
    const text = await readFile(filePath, 'utf8');
    const units = text.split('\n').filter((line) => line.trim().length > 0).length;
    return { exists: true, units };
  } catch {
    return { exists: false, units: 0 };
  }
}
