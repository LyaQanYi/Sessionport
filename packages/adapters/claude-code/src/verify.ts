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
  conversationRows: number;
  checks: VerifyCheck[];
}

interface AnyRow {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  timestamp?: unknown;
  message?: { role?: string; content?: unknown };
}

/**
 * Claude 自己追加的元数据行（resume 之后会出现在同一文件里）。
 * 这些行不参与对话回放，校验时放行。
 */
const METADATA_ROW_TYPES = new Set([
  'attachment',
  'last-prompt',
  'mode',
  'permission-mode',
  'atis-latch',
  'queue-operation',
  'cost-state',
  'custom-title',
  'pr-link',
  'agent-name',
  'file-history-snapshot',
  'file-history-delta',
  'system',
  'summary',
  'relocated',
  'worktree-state',
  'api-request',
  'api-request-shape',
  'api-request-blob',
  'last-prompt-state',
]);

/** Claude 会清洗/原样转发 content block；adapter 只应产出这三种 */
const ALLOWED_BLOCK_TYPES = new Set(['text', 'tool_use', 'tool_result', 'thinking', 'redacted_thinking']);

function blocksOf(row: AnyRow): Array<{ type?: string; id?: string; tool_use_id?: string }> {
  const content = row.message?.content;
  if (Array.isArray(content)) return content as Array<{ type?: string }>;
  return [];
}

/** 结构自检：不依赖目标 CLI，先保证文件本身是自洽的 */
export async function verifyClaudeSession(options: { configDir?: string; cwd: string; sessionId: string }): Promise<VerifyReport> {
  const configDir = claudeConfigDir(options.configDir);
  const filePath = sessionFilePath(configDir, options.cwd, options.sessionId);
  const checks: VerifyCheck[] = [];

  const exists = existsSync(filePath);
  checks.push({ name: 'file-exists', ok: exists, detail: filePath });
  if (!exists) return { ok: false, filePath, rows: 0, conversationRows: 0, checks };

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

  const conversation = rows.filter((r) => r.type === 'user' || r.type === 'assistant');
  const unknown = rows.filter((r) => r.type !== 'user' && r.type !== 'assistant' && !METADATA_ROW_TYPES.has(r.type ?? ''));
  checks.push({
    name: 'row-types',
    ok: unknown.length === 0,
    detail: unknown.length === 0 ? 'ok' : [...new Set(unknown.map((r) => r.type))].join(','),
  });
  checks.push({
    name: 'has-conversation-rows',
    ok: conversation.length > 0,
    detail: conversation.length + ' 条对话行',
  });

  // parentUuid 必须指向文件里更早出现的一条记录（Claude 追加的元数据行也会入链）
  const seen = new Set<string>();
  let brokenChain = 0;
  for (const row of rows) {
    if (row.type === 'user' || row.type === 'assistant') {
      if (row.parentUuid === null || row.parentUuid === undefined) {
        if (seen.size > 0) brokenChain += 1;
      } else if (!seen.has(row.parentUuid)) {
        brokenChain += 1;
      }
    }
    if (row.uuid) seen.add(row.uuid);
  }
  checks.push({ name: 'parent-chain', ok: brokenChain === 0, detail: brokenChain + ' 处断链' });

  const uuids = conversation.map((r) => r.uuid).filter((u): u is string => typeof u === 'string');
  checks.push({
    name: 'uuid-present-and-unique',
    ok: uuids.length === conversation.length && new Set(uuids).size === uuids.length,
    detail: uuids.length + '/' + conversation.length,
  });

  const sessionIds = new Set(conversation.map((r) => r.sessionId).filter((v) => v !== undefined));
  checks.push({
    name: 'session-id-consistent',
    ok: sessionIds.size <= 1,
    detail: sessionIds.size === 0 ? '行内未写 sessionId（可省）' : [...sessionIds].join(','),
  });

  // leaf 的 timestamp 必须可解析，否则 loader 选不出 leaf → "No conversation found"
  const leaf = conversation[conversation.length - 1];
  const leafTs = leaf === undefined ? Number.NaN : Date.parse(String(leaf.timestamp));
  checks.push({
    name: 'leaf-timestamp',
    ok: Number.isFinite(leafTs),
    detail: leaf === undefined ? '无对话行' : String(leaf.timestamp),
  });

  const emptyAssistant = conversation.filter((r) => r.type === 'assistant' && blocksOf(r).length === 0);
  checks.push({ name: 'assistant-content-nonempty', ok: emptyAssistant.length === 0, detail: emptyAssistant.length + ' 行空内容' });

  const weirdBlocks = conversation.flatMap(blocksOf).filter((b) => !ALLOWED_BLOCK_TYPES.has(b.type ?? ''));
  checks.push({
    name: 'content-block-types',
    ok: weirdBlocks.length === 0,
    detail: weirdBlocks.length === 0 ? 'ok' : [...new Set(weirdBlocks.map((b) => b.type))].join(','),
  });

  // tool_use ↔ tool_result 配对
  let missingResults = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    if (row.type !== 'assistant') continue;
    const toolUses = blocksOf(row).filter((b) => b.type === 'tool_use').map((b) => b.id);
    if (toolUses.length === 0) continue;
    const next = rows.slice(i + 1).find((r) => r.type === 'user');
    const resultIds = new Set(blocksOf(next ?? {}).filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id));
    for (const id of toolUses) if (id && !resultIds.has(id)) missingResults += 1;
  }
  checks.push({ name: 'tool-pairing', ok: missingResults === 0, detail: missingResults + ' 个 tool_use 缺结果' });

  return { ok: checks.every((c) => c.ok), filePath, rows: rows.length, conversationRows: conversation.length, checks };
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
 *
 * 注意：stdin 必须设为 ignore —— 管道 stdin 会让 claude 等待 3 秒并可能导致
 * resume 失败（实测 "No conversation found"），只有 /dev/null 行为才正确。
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
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs ?? 180000);
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