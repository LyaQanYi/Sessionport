import { existsSync } from 'node:fs';

import { validateIrBundle } from '@sessionport/core';
import type { IrBundle } from '@sessionport/core';

import { readWorkBuddySession } from './read.ts';
import type { ReadWorkBuddyOptions } from './read.ts';
import { parseWorkBuddyLines, readFileText, resolveWorkBuddySessionPath, workBuddyHome } from './wire.ts';

export interface VerifyCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface VerifyWorkBuddyReport {
  ok: boolean;
  sessionId?: string;
  path?: string;
  checks: VerifyCheck[];
  bundle?: IrBundle;
}

/** bundle 自检：结构、链、工具配对、子代理 */
export function verifyWorkBuddyBundle(bundle: IrBundle): VerifyCheck[] {
  const checks: VerifyCheck[] = [];
  const structural = validateIrBundle(bundle);
  checks.push({ name: 'ir-structure', ok: structural.length === 0, detail: structural.length === 0 ? 'ok' : structural.slice(0, 3).join('; ') });

  const root = bundle.root;
  checks.push({ name: 'session-id', ok: typeof root.source.nativeSessionId === 'string' && root.source.nativeSessionId.length > 0, detail: String(root.source.nativeSessionId ?? 'missing') });
  checks.push({ name: 'has-events', ok: root.events.length > 0, detail: root.events.length + ' events' });
  checks.push({ name: 'has-user-message', ok: root.events.some((event) => event.kind === 'message' && event.role === 'user'), detail: '' });
  checks.push({ name: 'has-assistant-message', ok: root.events.some((event) => event.kind === 'message' && event.role === 'assistant'), detail: '' });

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
  checks.push({ name: 'tool-pairing', ok: orphan === 0, detail: 'calls=' + calls.size + ' results=' + results.size + ' orphan=' + orphan + ' pending=' + pending });
  checks.push({ name: 'reasoning-text', ok: root.events.every((event) => event.kind !== 'reasoning' || event.reasoning.kind !== 'plain' || event.reasoning.text.length > 0), detail: '' });
  checks.push({ name: 'children-chain', ok: bundle.children.every((child) => validateIrBundle({ irVersion: bundle.irVersion, createdAt: bundle.createdAt, root: child.session, children: [] }).length === 0), detail: bundle.children.length + ' children' });
  return checks;
}

/** 真实 transcript 自检（会读盘、会读子代理） */
export async function verifyWorkBuddySession(input: string, options: ReadWorkBuddyOptions = {}): Promise<VerifyWorkBuddyReport> {
  const home = workBuddyHome(options.home);
  const path = resolveWorkBuddySessionPath(input, home);
  const checks: VerifyCheck[] = [{ name: 'file-exists', ok: existsSync(path), detail: path }];
  if (!existsSync(path)) return { ok: false, checks };
  const text = readFileText(path);
  const parsed = parseWorkBuddyLines(text);
  checks.push({ name: 'jsonl-parse', ok: parsed.badLines === 0, detail: parsed.totalLines + ' lines, ' + parsed.badLines + ' bad' });
  checks.push({ name: 'session-meta', ok: parsed.lines.some((line) => line.type === 'session-meta'), detail: '' });
  checks.push({ name: 'ai-title', ok: parsed.lines.some((line) => line.type === 'ai-title'), detail: '' });
  const bundle = await readWorkBuddySession(path, options);
  checks.push(...verifyWorkBuddyBundle(bundle));
  return {
    ok: checks.every((check) => check.ok),
    sessionId: bundle.root.source.nativeSessionId,
    path,
    checks,
    bundle,
  };
}
