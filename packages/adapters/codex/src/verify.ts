import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import type { CodexLine } from './wire.ts';
import { codexHome, parseRollout, sessionIdFromRolloutPath } from './wire.ts';

export interface VerifyCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface VerifyCodexReport {
  ok: boolean;
  filePath: string;
  lines: number;
  checks: VerifyCheck[];
}

export interface VerifyCodexOptions {
  filePath?: string;
  home?: string;
  sessionId?: string;
}

function blocksOf(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(payload.content) ? (payload.content as Array<Record<string, unknown>>) : [];
}

/** 结构自检：不依赖 Codex，先保证 rollout 自洽、可被 loader 接受 */
export async function verifyCodexSession(options: VerifyCodexOptions): Promise<VerifyCodexReport> {
  void codexHome(options.home);
  let filePath = options.filePath;
  if (filePath === undefined && options.sessionId !== undefined) {
    // 交给调用方解析更准确；这里只做简单兜底
    filePath = options.sessionId;
  }
  if (filePath === undefined) throw new Error('verifyCodexSession 需要 filePath 或 sessionId');

  const checks: VerifyCheck[] = [];
  const exists = existsSync(filePath);
  checks.push({ name: 'file-exists', ok: exists, detail: filePath });
  if (!exists) return { ok: false, filePath, lines: 0, checks };

  const text = readFileSync(filePath, 'utf8');
  const parsed = parseRollout(text);
  checks.push({ name: 'jsonl-parses', ok: parsed.badLines === 0, detail: parsed.badLines + ' 行无法解析' });
  checks.push({ name: 'has-content', ok: parsed.lines.length > 0, detail: parsed.lines.length + ' 行' });

  const header = parsed.lines.find((line) => line.type === 'session_meta');
  const headerId = header?.payload?.session_id ?? header?.payload?.id;
  checks.push({
    name: 'session-meta-first',
    ok: parsed.lines[0]?.type === 'session_meta' && typeof headerId === 'string',
    detail: String(headerId ?? 'missing'),
  });

  const fileId = sessionIdFromRolloutPath(filePath);
  checks.push({
    name: 'header-id-matches-filename',
    ok: fileId !== undefined && headerId === fileId,
    detail: String(headerId ?? '?') + ' vs ' + String(fileId ?? '?'),
  });

  const cwd = header?.payload?.cwd;
  checks.push({ name: 'session-meta-cwd', ok: typeof cwd === 'string' && cwd.startsWith('/'), detail: String(cwd ?? 'missing') });

  const badTimestamps = parsed.lines.filter((line) => !Number.isFinite(Date.parse(String(line.timestamp))));
  checks.push({ name: 'timestamps-parseable', ok: badTimestamps.length === 0, detail: badTimestamps.length + ' 行非法' });

  const responseItems = parsed.lines.filter((line) => line.type === 'response_item');
  const messageItems = responseItems.filter((line) => line.payload?.type === 'message');
  const badMessages = messageItems.filter((line) => {
    const role = line.payload?.role;
    return role !== 'user' && role !== 'assistant' && role !== 'developer' && role !== 'system';
  });
  checks.push({ name: 'message-roles', ok: badMessages.length === 0, detail: badMessages.length + ' 行 role 异常' });

  const badContent = messageItems.filter((line) => {
    const blocks = blocksOf(line.payload ?? {});
    return blocks.length > 0 && blocks.some((block) => typeof block.type !== 'string');
  });
  checks.push({ name: 'message-content-shape', ok: badContent.length === 0, detail: badContent.length + ' 行 content 异常' });

  const calls = responseItems.filter((line) => line.payload?.type === 'function_call');
  const outputs = responseItems.filter((line) => line.payload?.type === 'function_call_output');
  const callIds = new Set(calls.map((line) => String(line.payload?.call_id ?? '')));
  const outputIds = new Set(outputs.map((line) => String(line.payload?.call_id ?? '')));
  const orphanCalls = [...callIds].filter((id) => id.length > 0 && !outputIds.has(id));
  const orphanOutputs = [...outputIds].filter((id) => id.length > 0 && !callIds.has(id));
  checks.push({
    name: 'tool-pairing',
    ok: orphanCalls.length === 0 && orphanOutputs.length === 0,
    detail: 'calls=' + calls.length + ' outputs=' + outputs.length + ' 缺结果=' + orphanCalls.length + ' 孤立结果=' + orphanOutputs.length,
  });

  const badArgs = calls.filter((line) => {
    const raw = line.payload?.arguments;
    if (typeof raw !== 'string') return true;
    try {
      JSON.parse(raw);
      return false;
    } catch {
      return true;
    }
  });
  checks.push({ name: 'tool-arguments-json', ok: badArgs.length === 0, detail: badArgs.length + ' 条 arguments 非 JSON' });

  // 短会话可能只有 user 消息（甚至只有 tool 往返），因此只要求有对话内容
  const hasConversation = messageItems.length > 0 || calls.length > 0;
  checks.push({ name: 'has-conversation', ok: hasConversation, detail: messageItems.length + ' 条 message, ' + calls.length + ' 条 tool call' });

  return { ok: checks.every((check) => check.ok), filePath, lines: parsed.lines.length, checks };
}

/** 计数：供 sync 判断目标端是否被续写 */
export async function countCodexTarget(filePath: string): Promise<{ exists: boolean; units: number }> {
  try {
    const parsed = parseRollout(readFileSync(filePath, 'utf8'));
    return { exists: true, units: parsed.lines.length };
  } catch {
    return { exists: false, units: 0 };
  }
}

export function codexDisplayName(filePath: string): string {
  return basename(filePath);
}
export interface CodexResumeSmokeOptions {
  home: string;
  sessionId: string;
  cwd?: string;
  prompt?: string;
  timeoutMs?: number;
}

export interface CodexResumeSmokeResult {
  ok: boolean;
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * 真实验收：让 Codex 加载这个会话并继续。
 * 注意 stdin 必须 /dev/null（'ignore'），否则 codex 会等 stdin 影响执行。
 */
export function resumeSmokeCodex(options: CodexResumeSmokeOptions): Promise<CodexResumeSmokeResult> {
  const prompt = options.prompt ?? 'Reply with exactly: RESUME_OK';
  const args = ['exec', 'resume', '--skip-git-repo-check', options.sessionId, '--json', prompt];
  const command = 'CODEX_HOME=' + options.home + ' codex ' + args.map((arg) => (arg.includes(' ') ? JSON.stringify(arg) : arg)).join(' ');
  return new Promise((resolvePromise) => {
    const child = spawn('codex', args, {
      cwd: options.cwd ?? process.cwd(),
      env: { ...process.env, CODEX_HOME: options.home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs ?? 180000);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({
        ok: code === 0 && !timedOut && stdout.includes('RESUME_OK'),
        command,
        exitCode: code,
        stdout: stdout.slice(-4000),
        stderr: stderr.slice(-4000),
        timedOut,
      });
    });
  });
}
/** 从 rollout 路径反推 CODEX_HOME（.../sessions/YYYY/MM/DD/rollout-*.jsonl 的上三级是 sessions 的父） */
export function inferCodexHome(filePath: string): string | undefined {
  const marker = filePath.split('/').lastIndexOf('sessions');
  if (marker <= 0) return undefined;
  return filePath.split('/').slice(0, marker).join('/');
}
