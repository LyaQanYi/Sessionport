import { existsSync } from 'node:fs';

import { validateIrBundle } from '@sessionport/core';
import type { IrBundle } from '@sessionport/core';

import { readAntigravitySession } from './read.ts';
import type { ReadAntigravityOptions } from './read.ts';
import { parseAntigravityLines, readFileText, resolveAntigravitySessionPath } from './wire.ts';

export interface VerifyCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface VerifyAntigravityReport {
  ok: boolean;
  sessionId?: string;
  path?: string;
  checks: VerifyCheck[];
  bundle?: IrBundle;
}

const KNOWN_STEP_TYPES = new Set([
  'USER_INPUT',
  'PLANNER_RESPONSE',
  'GENERIC',
  'SYSTEM_MESSAGE',
  'ERROR_MESSAGE',
  'CHECKPOINT',
]);

/** bundle 自检：IR 结构、会话 id、对话消息、工具配对、thinking 完整性、子会话链 */
export function verifyAntigravityBundle(bundle: IrBundle): VerifyCheck[] {
  const checks: VerifyCheck[] = [];
  const structural = validateIrBundle(bundle);
  checks.push({
    name: 'ir-structure',
    ok: structural.length === 0,
    detail: structural.length === 0 ? 'ok' : structural.slice(0, 3).join('; '),
  });

  const root = bundle.root;
  checks.push({
    name: 'session-id',
    ok: typeof root.source.nativeSessionId === 'string' && root.source.nativeSessionId.length > 0,
    detail: String(root.source.nativeSessionId ?? 'missing'),
  });
  checks.push({ name: 'has-events', ok: root.events.length > 0, detail: root.events.length + ' events' });
  checks.push({
    name: 'has-user-message',
    ok: root.events.some((event) => event.kind === 'message' && event.role === 'user'),
    detail: '',
  });
  checks.push({
    name: 'has-assistant-message',
    ok: root.events.some((event) => event.kind === 'message' && event.role === 'assistant'),
    detail: '',
  });

  let pending = 0;
  let orphan = 0;
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const event of root.events) {
    if (event.kind === 'tool_call') calls.add(event.callId);
    if (event.kind === 'tool_result') {
      if (!calls.has(event.callId)) orphan += 1;
      results.add(event.callId);
    }
  }
  for (const callId of calls) if (!results.has(callId)) pending += 1;
  checks.push({
    name: 'tool-pairing',
    ok: orphan === 0,
    detail: 'calls=' + calls.size + ' results=' + results.size + ' orphan=' + orphan + ' pending=' + pending,
  });
  checks.push({
    name: 'reasoning-text',
    ok: root.events.every((event) => event.kind !== 'reasoning' || event.reasoning.kind !== 'plain' || event.reasoning.text.length > 0),
    detail: '',
  });
  checks.push({
    name: 'children-chain',
    ok: bundle.children.every(
      (child) => validateIrBundle({ irVersion: bundle.irVersion, createdAt: bundle.createdAt, root: child.session, children: [] }).length === 0,
    ),
    detail: bundle.children.length + ' children',
  });
  return checks;
}

/** 真实 Antigravity transcript 自检（会读盘与子代理） */
export async function verifyAntigravitySession(
  input: string,
  options: ReadAntigravityOptions = {},
): Promise<VerifyAntigravityReport> {
  let resolvedPath = '';
  try {
    resolvedPath = resolveAntigravitySessionPath(input, options.home).path;
  } catch (error) {
    return {
      ok: false,
      checks: [{ name: 'file-exists', ok: false, detail: error instanceof Error ? error.message : String(error) }],
    };
  }

  const checks: VerifyCheck[] = [{ name: 'file-exists', ok: existsSync(resolvedPath), detail: resolvedPath }];
  if (!existsSync(resolvedPath)) return { ok: false, checks };

  const text = readFileText(resolvedPath);
  const parsed = parseAntigravityLines(text);
  checks.push({
    name: 'jsonl-parse',
    ok: parsed.badLines === 0,
    detail: parsed.totalLines + ' lines, ' + parsed.badLines + ' bad',
  });
  checks.push({
    name: 'has-antigravity-steps',
    ok: parsed.lines.some((line) => typeof line.type === 'string' && KNOWN_STEP_TYPES.has(line.type)),
    detail: parsed.lines.length + ' parsed rows',
  });

  const bundle = await readAntigravitySession(resolvedPath, options);
  checks.push(...verifyAntigravityBundle(bundle));
  return {
    ok: checks.every((check) => check.ok),
    sessionId: bundle.root.source.nativeSessionId,
    path: resolvedPath,
    checks,
    bundle,
  };
}
