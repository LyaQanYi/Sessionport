import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { basename, join } from 'node:path';

import { claudeConfigDir, sessionFilePath, subagentsDirPath } from './paths.ts';

export interface VerifyCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

/** 期望存在的子代理（通常来自 writeClaudeSession 返回的 children） */
export interface VerifySubagentExpectation {
  agentId: string;
  agentType?: string;
  description?: string;
  toolUseId?: string;
}

export interface VerifySubagentReport {
  agentId: string;
  filePath: string;
  metaPath: string;
  rows: number;
  conversationRows: number;
  ok: boolean;
}

export interface VerifyReport {
  ok: boolean;
  filePath: string;
  rows: number;
  conversationRows: number;
  /** 本次发现并校验的子代理 transcript（没有 subagents 目录时为空） */
  subagents: VerifySubagentReport[];
  checks: VerifyCheck[];
}

export interface VerifyClaudeOptions {
  configDir?: string;
  cwd: string;
  sessionId: string;
  /** 传入后额外检查每个 child 都有文件，且 meta.json 字段与 child 对应 */
  expectedChildren?: VerifySubagentExpectation[];
}

interface AnyRow {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  timestamp?: unknown;
  isSidechain?: boolean;
  agentId?: string;
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

/** <sessionId>/subagents 下任意层级（workflows 会再嵌套一层）的 agent-<agentId>.jsonl */
const SUBAGENT_FILE_PATTERN = /^agent-([A-Za-z0-9]+)\.jsonl$/u;
const SUBAGENT_SCAN_MAX_DEPTH = 4;

function blocksOf(row: AnyRow): Array<{ type?: string; id?: string; tool_use_id?: string }> {
  const content = row.message?.content;
  if (Array.isArray(content)) return content as Array<{ type?: string }>;
  return [];
}

function parentChainBroken(rows: AnyRow[]): number {
  const seen = new Set<string>();
  let broken = 0;
  for (const row of rows) {
    if (row.type === 'user' || row.type === 'assistant') {
      if (row.parentUuid === null || row.parentUuid === undefined) {
        if (seen.size > 0) broken += 1;
      } else if (!seen.has(row.parentUuid)) {
        broken += 1;
      }
    }
    if (row.uuid) seen.add(row.uuid);
  }
  return broken;
}

function missingToolResults(rows: AnyRow[]): number {
  let missing = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    if (row.type !== 'assistant') continue;
    const toolUses = blocksOf(row).filter((b) => b.type === 'tool_use').map((b) => b.id);
    if (toolUses.length === 0) continue;
    const next = rows.slice(i + 1).find((r) => r.type === 'user');
    const resultIds = new Set(blocksOf(next ?? {}).filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id));
    for (const id of toolUses) if (id && !resultIds.has(id)) missing += 1;
  }
  return missing;
}

async function collectSubagentFiles(dir: string, depth = 0): Promise<string[]> {
  if (depth > SUBAGENT_SCAN_MAX_DEPTH) return [];
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await collectSubagentFiles(full, depth + 1)));
    else if (entry.isFile() && SUBAGENT_FILE_PATTERN.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * 子代理文件检查：JSONL 可解析、每行 isSidechain/agentId、parentUuid 链自洽、
 * sessionId 与主会话一致、tool_use 有结果、meta.json 存在且字段合法。
 * 传入 expectedChildren 时再核对 meta.json 与 IR child 的对应关系。
 */
async function verifySubagents(options: VerifyClaudeOptions, checks: VerifyCheck[]): Promise<VerifySubagentReport[]> {
  const configDir = claudeConfigDir(options.configDir);
  const dir = subagentsDirPath(configDir, options.cwd, options.sessionId);
  const files = existsSync(dir) ? await collectSubagentFiles(dir) : [];
  const reports: VerifySubagentReport[] = [];
  const metaByAgent = new Map<string, Record<string, unknown> | undefined>();

  if (files.length > 0) {
    checks.push({ name: 'subagent-files', ok: true, detail: files.length + ' 份 agent transcript' });
  }

  for (const filePath of files) {
    const agentId = SUBAGENT_FILE_PATTERN.exec(basename(filePath))?.[1];
    if (agentId === undefined) continue;
    const start = checks.length;
    const metaPath = filePath.replace(/\.jsonl$/u, '.meta.json');

    const raw = await readFile(filePath, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    const rows: AnyRow[] = [];
    let badLines = 0;
    for (const line of lines) {
      try {
        const value = JSON.parse(line) as unknown;
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) rows.push(value as AnyRow);
        else badLines += 1;
      } catch {
        badLines += 1;
      }
    }
    checks.push({ name: 'subagent-' + agentId + '-jsonl-parses', ok: badLines === 0, detail: '解析失败 ' + badLines + ' 行' });

    const conversation = rows.filter((r) => r.type === 'user' || r.type === 'assistant');
    checks.push({
      name: 'subagent-' + agentId + '-has-conversation-rows',
      ok: conversation.length > 0,
      detail: conversation.length + ' 条对话行',
    });

    const sidechainBad = conversation.filter((row) => row.isSidechain !== true || row.agentId !== agentId).length;
    checks.push({
      name: 'subagent-' + agentId + '-sidechain-agent-id',
      ok: sidechainBad === 0,
      detail: sidechainBad === 0 ? 'ok' : sidechainBad + ' 行缺 isSidechain/agentId 或 agentId 不匹配',
    });

    const brokenChain = parentChainBroken(rows);
    checks.push({ name: 'subagent-' + agentId + '-parent-chain', ok: brokenChain === 0, detail: brokenChain + ' 处断链' });

    const sessionIds = new Set(conversation.map((r) => r.sessionId).filter((v): v is string => typeof v === 'string'));
    checks.push({
      name: 'subagent-' + agentId + '-session-id',
      ok: sessionIds.size <= 1 && (sessionIds.size === 0 || sessionIds.has(options.sessionId)),
      detail: sessionIds.size === 0 ? '行内未写 sessionId（可省）' : [...sessionIds].join(','),
    });

    const missing = missingToolResults(rows);
    checks.push({ name: 'subagent-' + agentId + '-tool-pairing', ok: missing === 0, detail: missing + ' 个 tool_use 缺结果' });

    let meta: Record<string, unknown> | undefined;
    let metaError = '';
    if (!existsSync(metaPath)) {
      metaError = 'meta.json 不存在';
    } else {
      try {
        const parsed = JSON.parse(await readFile(metaPath, 'utf8')) as unknown;
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) metaError = 'meta.json 不是对象';
        else meta = parsed as Record<string, unknown>;
      } catch {
        metaError = 'meta.json 解析失败';
      }
    }
    const agentTypeOk = typeof meta?.agentType === 'string' && meta.agentType.trim().length > 0;
    const descriptionOk =
      meta?.description === undefined || (typeof meta.description === 'string' && meta.description.trim().length > 0);
    const toolUseOk = meta?.toolUseId === undefined || (typeof meta.toolUseId === 'string' && meta.toolUseId.trim().length > 0);
    checks.push({
      name: 'subagent-' + agentId + '-meta',
      ok: meta !== undefined && agentTypeOk && descriptionOk && toolUseOk,
      detail: meta === undefined ? metaError : !agentTypeOk ? 'agentType 缺失' : !descriptionOk ? 'description 为空' : !toolUseOk ? 'toolUseId 为空' : 'ok',
    });
    metaByAgent.set(agentId, meta);

    reports.push({
      agentId,
      filePath,
      metaPath,
      rows: rows.length,
      conversationRows: conversation.length,
      ok: checks.slice(start).every((check) => check.ok),
    });
  }

  const expected = options.expectedChildren ?? [];
  if (expected.length > 0) {
    const byAgent = new Map(reports.map((report) => [report.agentId, report]));
    const missing = expected.filter((item) => !byAgent.has(item.agentId)).map((item) => item.agentId);
    const expectedIds = new Set(expected.map((item) => item.agentId));
    const extra = reports.filter((report) => !expectedIds.has(report.agentId)).map((report) => report.agentId);
    const parts: string[] = [];
    if (missing.length > 0) parts.push('缺少 ' + missing.join(','));
    if (extra.length > 0) parts.push('多出 ' + extra.join(','));
    checks.push({
      name: 'subagent-files-match-children',
      ok: missing.length === 0 && extra.length === 0,
      detail: parts.length === 0 ? 'ok' : parts.join('；'),
    });

    const mismatches: string[] = [];
    for (const item of expected) {
      const meta = metaByAgent.get(item.agentId);
      if (meta === undefined) {
        mismatches.push(item.agentId + ':meta');
        continue;
      }
      if (item.agentType !== undefined && meta.agentType !== item.agentType) mismatches.push(item.agentId + ':agentType');
      if (item.description !== undefined && meta.description !== item.description) mismatches.push(item.agentId + ':description');
      if (item.toolUseId !== undefined && meta.toolUseId !== item.toolUseId) mismatches.push(item.agentId + ':toolUseId');
    }
    checks.push({
      name: 'subagent-meta-matches-children',
      ok: mismatches.length === 0,
      detail: mismatches.length === 0 ? 'ok' : mismatches.join(','),
    });
  }

  return reports;
}

/** 结构自检：不依赖目标 CLI，先保证文件本身是自洽的 */
export async function verifyClaudeSession(options: VerifyClaudeOptions): Promise<VerifyReport> {
  const configDir = claudeConfigDir(options.configDir);
  const filePath = sessionFilePath(configDir, options.cwd, options.sessionId);
  const checks: VerifyCheck[] = [];

  const exists = existsSync(filePath);
  checks.push({ name: 'file-exists', ok: exists, detail: filePath });
  if (!exists) return { ok: false, filePath, rows: 0, conversationRows: 0, subagents: [], checks };

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
  const brokenChain = parentChainBroken(rows);
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
  const missingResults = missingToolResults(rows);
  checks.push({ name: 'tool-pairing', ok: missingResults === 0, detail: missingResults + ' 个 tool_use 缺结果' });

  const subagents = await verifySubagents(options, checks);

  return { ok: checks.every((c) => c.ok), filePath, rows: rows.length, conversationRows: conversation.length, subagents, checks };
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
