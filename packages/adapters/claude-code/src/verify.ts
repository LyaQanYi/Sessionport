import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

import { claudeConfigDir, sessionFilePath } from './paths.ts';

export interface VerifyCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface VerifyReport {
  ok: boolean;
  filePath: string;
  rows: number;
  checks: VerifyCheck[];
}

interface AnyRow {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  message?: { role?: string; content?: unknown[] };
}

/** 结构自检：不依赖目标 CLI，先保证文件本身是自洽的 */
export async function verifyClaudeSession(options: { configDir?: string; cwd: string; sessionId: string }): Promise<VerifyReport> {
  const configDir = claudeConfigDir(options.configDir);
  const filePath = sessionFilePath(configDir, options.cwd, options.sessionId);
  const checks: VerifyCheck[] = [];

  const exists = existsSync(filePath);
  checks.push({ name: 'file-exists', ok: exists, detail: filePath });
  if (!exists) return { ok: false, filePath, rows: 0, checks };

  const raw = await readFile(filePath, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const rows: AnyRow[] = [];
  let badLines = 0;
  for (const line of lines) {
    try {
      rows.push(JSON.parse(line) as AnyRow);
    } catch {
      badLines += 1;
    }
  }
  checks.push({ name: 'jsonl-parses', ok: badLines === 0, detail: '解析失败 ' + badLines + ' 行' });

  const types = new Set(rows.map((r) => r.type));
  const unknownTypes = [...types].filter((t) => t !== 'user' && t !== 'assistant');
  checks.push({ name: 'row-types', ok: unknownTypes.length === 0, detail: unknownTypes.join(',') || 'ok' });

  const chainOk = rows.every((r, i) => (i === 0 ? r.parentUuid === null : r.parentUuid === rows[i - 1]!.uuid));
  checks.push({ name: 'parent-chain', ok: chainOk });

  const sessionIds = new Set(rows.map((r) => r.sessionId));
  checks.push({ name: 'session-id-consistent', ok: sessionIds.size === 1 && sessionIds.has(options.sessionId), detail: [...sessionIds].join(',') });

  const emptyAssistant = rows.filter((r) => r.type === 'assistant' && (r.message?.content ?? []).length === 0);
  checks.push({ name: 'assistant-content-nonempty', ok: emptyAssistant.length === 0, detail: emptyAssistant.length + ' 行空内容' });

  // tool_use ↔ tool_result 配对
  let missingResults = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    if (row.type !== 'assistant') continue;
    const toolUses = (row.message?.content ?? [])
      .map((b) => b as { type?: string; id?: string })
      .filter((b) => b.type === 'tool_use')
      .map((b) => b.id);
    if (toolUses.length === 0) continue;
    const next = rows[i + 1];
    const resultIds = new Set(
      (next?.message?.content ?? [])
        .map((b) => b as { type?: string; tool_use_id?: string })
        .filter((b) => b.type === 'tool_result')
        .map((b) => b.tool_use_id),
    );
    for (const id of toolUses) if (id && !resultIds.has(id)) missingResults += 1;
  }
  checks.push({ name: 'tool-pairing', ok: missingResults === 0, detail: missingResults + ' 个 tool_use 缺结果' });

  return { ok: checks.every((c) => c.ok), filePath, rows: rows.length, checks };
}

export interface ResumeSmokeResult {
  ok: boolean;
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * 真正的验收：让目标 CLI 以无头模式 resume 这个会话。
 * 需要能访问模型（会消耗一次真实调用），因此单独开关。
 */
export function resumeSmoke(options: {
  configDir?: string;
  cwd: string;
  sessionId: string;
  prompt?: string;
  timeoutMs?: number;
}): Promise<ResumeSmokeResult> {
  const configDir = claudeConfigDir(options.configDir);
  const prompt = options.prompt ?? 'Reply with exactly: RESUME_OK';
  const args = ['-p', '--resume', options.sessionId, '--output-format', 'json', prompt];
  const command = 'CLAUDE_CONFIG_DIR=' + configDir + ' claude ' + args.join(' ');
  return new Promise((resolveResult) => {
    const child = spawn('claude', args, {
      cwd: options.cwd,
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs ?? 120000);
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveResult({
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
