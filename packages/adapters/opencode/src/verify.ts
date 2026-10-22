import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { opencodeCliBinary, parseOpencodeExport } from './wire.ts';
import { exportOpencodeSession } from './read.ts';
import type { OpencodeExport } from './wire.ts';

export interface VerifyCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface VerifyOpencodeReport {
  ok: boolean;
  sessionId?: string;
  checks: VerifyCheck[];
}

export interface VerifyOpencodeOptions {
  /** 导出的 JSON 文件路径（结构校验用） */
  filePath?: string;
  /** 会话 id（resume 冒烟用） */
  sessionId?: string;
  env?: Record<string, string>;
  binary?: string;
  cwd?: string;
}

/** 结构自检：导出 JSON 是否自洽、能否被 opencode 导入 */
export function verifyOpencodeExport(raw: OpencodeExport): VerifyCheck[] {
  const checks: VerifyCheck[] = [];
  const info = raw.info ?? {};
  checks.push({ name: 'session-info', ok: typeof info.id === 'string' && info.id.startsWith('ses_'), detail: String(info.id ?? 'missing') });
  checks.push({ name: 'directory', ok: typeof info.directory === 'string' && info.directory.startsWith('/'), detail: String(info.directory ?? 'missing') });
  checks.push({ name: 'title', ok: typeof info.title === 'string' && info.title.length > 0, detail: String(info.title ?? '') });
  checks.push({ name: 'version', ok: typeof info.version === 'string', detail: String(info.version ?? 'missing') });

  const messages = Array.isArray(raw.messages) ? raw.messages : [];
  const sessionId = String(info.id ?? '');
  const badMessages = messages.filter((message) => {
    const messageInfo = message.info ?? {};
    return typeof messageInfo.id !== 'string' || messageInfo.sessionID !== sessionId || (messageInfo.role !== 'user' && messageInfo.role !== 'assistant');
  });
  checks.push({ name: 'message-shape', ok: badMessages.length === 0, detail: badMessages.length + ' 条异常' });
  checks.push({ name: 'has-conversation', ok: messages.length > 0, detail: messages.length + ' 条消息' });

  let badParts = 0;
  let toolParts = 0;
  let missingToolState = 0;
  let toolWithoutInput = 0;
  for (const message of messages) {
    const messageInfo = message.info ?? {};
    for (const part of message.parts ?? []) {
      if (typeof part.type !== 'string') badParts += 1;
      if (part.id === undefined || part.sessionID !== sessionId || part.messageID !== messageInfo.id) badParts += 1;
      if (part.type === 'tool') {
        toolParts += 1;
        if (part.state === undefined) missingToolState += 1;
        else if (part.state.input === undefined) toolWithoutInput += 1;
      }
    }
  }
  checks.push({ name: 'part-shape', ok: badParts === 0, detail: badParts + ' 处异常' });
  checks.push({ name: 'tool-parts', ok: missingToolState === 0 && toolWithoutInput === 0, detail: 'tool parts=' + toolParts + ' 缺 state=' + missingToolState + ' 缺 input=' + toolWithoutInput });

  return checks;
}

export async function verifyOpencodeSession(options: VerifyOpencodeOptions): Promise<VerifyOpencodeReport> {
  if (options.filePath === undefined) {
    if (options.sessionId === undefined) throw new Error('verifyOpencodeSession 需要 filePath 或 sessionId');
    const raw = await exportOpencodeSession(options.sessionId, { binary: options.binary, env: options.env, cwd: options.cwd });
    const checks = verifyOpencodeExport(raw);
    return { ok: checks.every((check) => check.ok), sessionId: options.sessionId, checks };
  }
  const exists = existsSync(options.filePath);
  if (!exists) return { ok: false, checks: [{ name: 'file-exists', ok: false, detail: options.filePath }] };
  const raw = parseOpencodeExport(readFileSync(options.filePath, 'utf8'));
  const checks = verifyOpencodeExport(raw);
  return { ok: checks.every((check) => check.ok), sessionId: raw.info?.id, checks };
}

export interface OpencodeResumeSmokeOptions {
  sessionId: string;
  prompt?: string;
  /** 显式指定模型 provider/model（导入会话的源模型在目标端不一定可用） */
  model?: string;
  env?: Record<string, string>;
  binary?: string;
  cwd?: string;
  timeoutMs?: number;
}

export interface OpencodeResumeSmokeResult {
  ok: boolean;
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * 真实验收：opencode run --session <id> 能否加载并继续。
 *
 * 同样要绕开 64KB 管道截断：把 stdout 接到临时文件再读回。
 */
export async function resumeSmokeOpencode(options: OpencodeResumeSmokeOptions): Promise<OpencodeResumeSmokeResult> {
  const binary = opencodeCliBinary(options.binary);
  const prompt = options.prompt ?? 'Reply with exactly: RESUME_OK';
  const args = ['run', '--session', options.sessionId, '--format', 'json', ...(options.model === undefined ? [] : ['-m', options.model]), prompt];
  const command = binary + ' ' + args.join(' ');
  const dir = mkdtempSync(join(tmpdir(), 'sessionport-opencode-run-'));
  const outFile = join(dir, 'stdout.log');
  const errFile = join(dir, 'stderr.log');
  const started = Date.now();
  return new Promise((resolvePromise) => {
    let timedOut = false;
    const fdOut = openSync(outFile, 'w');
    const fdErr = openSync(errFile, 'w');
    const child = spawn(binary, args, {
      cwd: options.cwd ?? process.cwd(),
      env: { ...process.env, ...options.env },
      stdio: ['ignore', fdOut, fdErr],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs ?? 300000);
    child.on('close', (code) => {
      clearTimeout(timer);
      closeSync(fdOut);
      closeSync(fdErr);
      let stdout = '';
      let stderr = '';
      try {
        stdout = readFileSync(outFile, 'utf8');
      } catch {
        stdout = '';
      }
      try {
        stderr = readFileSync(errFile, 'utf8');
      } catch {
        stderr = '';
      }
      rmSync(dir, { recursive: true, force: true });
      resolvePromise({
        ok: code === 0 && !timedOut && stdout.includes('RESUME_OK'),
        command,
        exitCode: code,
        stdout: stdout.slice(-4000),
        stderr: stderr.slice(-4000),
        timedOut,
      });
    });
    child.on('error', () => {
      clearTimeout(timer);
      try {
        closeSync(fdOut);
        closeSync(fdErr);
      } catch {
        // 已关闭
      }
      rmSync(dir, { recursive: true, force: true });
      resolvePromise({ ok: false, command, exitCode: null, stdout: '', stderr: 'spawn failed', timedOut });
    });
    void started;
  });
}

export function countOpencodeTarget(raw: OpencodeExport): { exists: boolean; units: number } {
  const messages = Array.isArray(raw.messages) ? raw.messages : [];
  return { exists: true, units: messages.length };
}