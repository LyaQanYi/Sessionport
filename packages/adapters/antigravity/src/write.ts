import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { LossCollector, classifyTool, contentToText } from '@sessionport/core';
import type {
  AdapterWriteOptions,
  AdapterWriteOutcome,
  IrBundle,
  IrEvent,
  IrMessageEvent,
  IrSession,
  LossEntry,
} from '@sessionport/core';

import {
  ANTIGRAVITY_AGENT,
  antigravityHome,
  clip,
  findAntigravityTranscriptFile,
  lookupAntigravityProjectId,
  textOf,
} from './wire.ts';

export interface WriteAntigravityOptions {
  home?: string;
  cwd?: string;
  id?: string;
  title?: string;
  model?: string;
  includeChildren?: boolean;
  dryRun?: boolean;
  handoffOnly?: boolean;
  lsAddress?: string;
  csrfToken?: string;
  projectId?: string;
  maxChars?: number;
  handoffDir?: string;
}

export interface AntigravityHandoffInfo {
  delivery: 'api' | 'handoff-file';
  mdPath: string;
  irPath: string;
  promptText: string;
  conversationId?: string;
  projectId?: string;
}

export interface BuiltAntigravityHandoff {
  markdown: string;
  promptText: string;
  omittedEvents: number;
  includedEvents: number;
  mdLines: number;
}

function messageText(event: IrMessageEvent): string {
  return event.parts
    .map((part) => (part.type === 'text' ? part.text : `[image: ${part.ref}]`))
    .join('\n')
    .trim();
}

function summarizeToolEvent(event: Extract<IrEvent, { kind: 'tool_call' }>): string {
  const canonical = classifyTool(event.name, event.input);
  if (canonical !== undefined) {
    switch (canonical.kind) {
      case 'shell':
        return 'shell: `' + clip(canonical.command, 100) + '`';
      case 'read':
        return 'read `' + canonical.path + '`';
      case 'write':
        return 'write `' + canonical.path + '`';
      case 'edit':
        return 'edit `' + canonical.path + '`';
      case 'patch':
        return 'apply_patch';
      case 'grep':
        return 'grep `' + clip(canonical.pattern, 60) + '`' + (canonical.path ? ' in `' + canonical.path + '`' : '');
      case 'glob':
        return 'glob `' + canonical.pattern + '`';
      case 'list':
        return 'list `' + canonical.path + '`';
      case 'todo':
        return 'todo (' + canonical.todos.length + ' items)';
    }
  }
  return event.name + '(' + clip(JSON.stringify(event.input), 90) + ')';
}

function formatEventBlock(event: IrEvent, perEventCap: number): string | undefined {
  if (event.kind === 'message') {
    const body = messageText(event);
    if (body.length === 0) return undefined;
    const tag = event.role === 'user' ? (event.synthetic ? 'User (synthetic)' : 'User') : event.synthetic ? 'Assistant (synthetic)' : 'Assistant';
    return `### ${tag} (${event.at})\n\n${clipMultiline(body, perEventCap)}`;
  }
  if (event.kind === 'reasoning') {
    if (event.reasoning.kind !== 'plain' || event.reasoning.text.trim().length === 0) return undefined;
    return `### Thinking (${event.at})\n\n${clipMultiline(event.reasoning.text.trim(), Math.min(perEventCap, 600))}`;
  }
  if (event.kind === 'tool_call') {
    return `- **Tool Call** \`${event.name}\` (\`${event.callId}\`): ${clip(JSON.stringify(event.input), 220)}`;
  }
  if (event.kind === 'tool_result') {
    const raw = contentToText(event.content).trim();
    const status = event.isError ? 'ERROR' : 'OK';
    const preview = raw.length > 0 ? clipMultiline(raw, Math.min(perEventCap, 500)) : '(empty output)';
    return `- **Tool Result [${status}]** (\`${event.callId}\`): ${preview}`;
  }
  return `- **Boundary (${event.boundary})**${event.detail ? ': ' + event.detail : ''}`;
}

function clipMultiline(text: string, maxLen: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLen) return trimmed;
  return trimmed.slice(0, Math.max(0, maxLen - 16)).trimEnd() + '\n… (truncated)';
}

function renderChildSummary(child: IrSession, label?: string): string {
  const header = `### Child Session: ${label ?? child.meta.title ?? child.source.nativeSessionId ?? child.id} (${child.events.length} events)`;
  const msgs = child.events.filter((e): e is IrMessageEvent => e.kind === 'message' && !e.synthetic);
  const firstMsg = msgs[0] ? clip(messageText(msgs[0]), 160) : undefined;
  const lastMsg = msgs.length > 1 ? clip(messageText(msgs[msgs.length - 1]!), 220) : undefined;
  const parts = [header];
  if (firstMsg) parts.push(`- **Prompt**: ${firstMsg}`);
  if (lastMsg) parts.push(`- **Outcome**: ${lastMsg}`);
  return parts.join('\n');
}

export function buildAntigravityHandoff(
  bundle: IrBundle,
  opts: {
    mdPath: string;
    irPath: string;
    title: string;
    cwd?: string;
    includeChildren?: boolean;
    maxChars?: number;
  },
): BuiltAntigravityHandoff {
  const maxChars =
    typeof opts.maxChars === 'number' && Number.isFinite(opts.maxChars)
      ? Math.max(2000, Math.floor(opts.maxChars))
      : 24000;
  const root = bundle.root;
  const sourceAgent = root.source.agent;
  const sourceId = root.source.nativeSessionId ?? root.id;

  const userRequests: string[] = [];
  for (const event of root.events) {
    if (event.kind !== 'message' || event.role !== 'user' || event.synthetic) continue;
    const text = messageText(event);
    if (text.length > 0) userRequests.push(clip(text, 200));
  }
  const cappedRequests = userRequests.slice(0, 20);

  const errorByCall = new Map<string, boolean>();
  for (const event of root.events) {
    if (event.kind === 'tool_result' && event.isError) errorByCall.set(event.callId, true);
  }
  const toolLines: string[] = [];
  for (const event of root.events) {
    if (event.kind !== 'tool_call') continue;
    const errTag = errorByCall.get(event.callId) ? ' [ERROR]' : '';
    toolLines.push(`- ${summarizeToolEvent(event)}${errTag}`);
  }
  const recentTools = toolLines.slice(-30);

  const recentBudget = Math.floor(maxChars * 0.65);
  const perEventCap = Math.min(2000, Math.max(400, Math.floor(recentBudget / 6)));
  const selectedBlocks: string[] = [];
  let usedRecentChars = 0;
  let includedEvents = 0;

  for (let i = root.events.length - 1; i >= 0; i -= 1) {
    const block = formatEventBlock(root.events[i]!, perEventCap);
    if (block === undefined) {
      includedEvents += 1;
      continue;
    }
    if (selectedBlocks.length > 0 && usedRecentChars + block.length + 2 > recentBudget) break;
    selectedBlocks.push(block);
    usedRecentChars += block.length + 2;
    includedEvents += 1;
  }
  selectedBlocks.reverse();
  const omittedEvents = Math.max(0, root.events.length - includedEvents);

  const mdSections: string[] = [
    `# Session Handoff: ${opts.title}`,
    '',
    `- **Source Harness**: \`${sourceAgent}\``,
    `- **Source Session ID**: \`${sourceId}\``,
    ...(opts.cwd ? [`- **Workspace (` + '`cwd`' + `)**: \`${opts.cwd}\``] : []),
    ...(root.meta.model ? [`- **Original Model**: \`${root.meta.model}\``] : []),
    `- **Total Root Events**: ${root.events.length}` + (omittedEvents > 0 ? ` (${omittedEvents} earlier events omitted from inline excerpt)` : ''),
    `- **Lossless IR Archive**: \`${opts.irPath}\``,
    '',
    '> Migrated via sessionport official context handoff. Antigravity renders this as a new starter conversation rather than native multi-turn history bubbles; use `read_file` on the IR archive above if you need omitted earlier steps.',
  ];

  if (cappedRequests.length > 0) {
    mdSections.push('', '## User Requests', '');
    cappedRequests.forEach((req, idx) => mdSections.push(`${idx + 1}. ${req}`));
  }

  if (recentTools.length > 0) {
    mdSections.push('', `## Key Actions (${recentTools.length} of ${toolLines.length} tool calls)`, '', ...recentTools);
  }

  if (selectedBlocks.length > 0) {
    mdSections.push('', '## Recent Conversation Excerpt', '', ...selectedBlocks);
  }

  if (opts.includeChildren === true && bundle.children.length > 0) {
    mdSections.push('', `## Child / Subagent Sessions (${bundle.children.length})`, '');
    for (const child of bundle.children) {
      mdSections.push(renderChildSummary(child.session, child.label), '');
    }
  }

  const markdown = mdSections.join('\n').trimEnd() + '\n';
  const mdLines = countNonEmptyLines(markdown);

  const promptCap = Math.min(maxChars, 14000);
  const promptHeader = [
    `Continue this coding session migrated by sessionport from \`${sourceAgent}\` (session \`${sourceId}\`).`,
    ...(opts.cwd ? [`Workspace: \`${opts.cwd}\``] : []),
    `Handoff file: \`${opts.mdPath}\``,
    `Full lossless IR JSON: \`${opts.irPath}\``,
    '',
    'Please review the context below, inspect the handoff/IR files with `read_file` if earlier details are needed, and acknowledge readiness or continue directly.',
  ].join('\n');

  let promptText = promptHeader;
  const requestSection =
    cappedRequests.length > 0
      ? '\n\n## User Requests\n' + cappedRequests.map((req, idx) => `${idx + 1}. ${req}`).join('\n')
      : '';
  if (promptText.length + requestSection.length <= promptCap) {
    promptText += requestSection;
  }

  if (selectedBlocks.length > 0) {
    const excerptHeader = '\n\n## Recent Context\n\n';
    const remaining = promptCap - promptText.length - excerptHeader.length;
    if (remaining > 400) {
      const joined = selectedBlocks.join('\n\n');
      promptText += excerptHeader + (joined.length <= remaining ? joined : joined.slice(joined.length - remaining));
    }
  }

  return {
    markdown,
    promptText,
    omittedEvents,
    includedEvents,
    mdLines,
  };
}

function resolveOptionString(opts: AdapterWriteOptions, key: string): string | undefined {
  return textOf(opts[key]);
}

function resolveOptionNumber(opts: AdapterWriteOptions, key: string): number | undefined {
  const val = opts[key];
  return typeof val === 'number' && Number.isFinite(val) ? val : undefined;
}

async function callCreateConversation(params: {
  lsAddress: string;
  csrfToken: string;
  title: string;
  projectId?: string;
  sourceAgent: string;
  model?: string;
  promptText: string;
}): Promise<{ conversationId: string; raw: unknown }> {
  const baseUrl = /^https?:\/\//iu.test(params.lsAddress)
    ? params.lsAddress.replace(/\/+$/u, '')
    : 'http://' + params.lsAddress.replace(/\/+$/u, '');
  const url = baseUrl + '/product.v1.ConversationService/CreateConversation';

  const body: Record<string, unknown> = {
    title: params.title,
    tags: ['sessionport', 'from:' + params.sourceAgent],
    prompt: [{ text: params.promptText }],
  };
  if (params.projectId !== undefined) body.projectId = params.projectId;
  if (params.model !== undefined) body.model = params.model;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1',
      'x-antigravity-csrf-token': params.csrfToken,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });

  const rawText = await response.text();
  if (!response.ok) {
    throw new Error(
      'Antigravity ConversationService/CreateConversation 请求失败 (HTTP ' +
        String(response.status) +
        '): ' +
        clip(rawText, 240),
    );
  }

  let parsed: { conversation?: { id?: unknown } };
  try {
    parsed = JSON.parse(rawText) as { conversation?: { id?: unknown } };
  } catch {
    throw new Error('Antigravity CreateConversation 返回了非 JSON 响应: ' + clip(rawText, 200));
  }
  const conversationId = textOf(parsed?.conversation?.id);
  if (conversationId === undefined) {
    throw new Error('Antigravity CreateConversation 响应缺少 conversation.id: ' + clip(rawText, 200));
  }
  return { conversationId, raw: parsed };
}

export async function writeAntigravitySession(
  bundle: IrBundle,
  options: WriteAntigravityOptions | AdapterWriteOptions = {},
): Promise<AdapterWriteOutcome> {
  const opts = options as Record<string, unknown>;
  const root = bundle.root;
  const home = antigravityHome(resolveOptionString(opts, 'home'));
  const cwd = resolveOptionString(opts, 'cwd') ?? root.meta.cwd;
  const title =
    resolveOptionString(opts, 'title') ??
    textOf(root.meta.title) ??
    'Imported from ' + root.source.agent;
  const model = resolveOptionString(opts, 'model');
  const includeChildren = opts.includeChildren === true;
  const dryRun = opts.dryRun === true;
  const handoffOnly = opts.handoffOnly === true;
  const maxChars = resolveOptionNumber(opts, 'maxChars');

  const handoffDir = resolveOptionString(opts, 'handoffDir') ?? join(home, 'scratch', 'sessionport-handoffs');
  const baseId = resolveOptionString(opts, 'id') ?? randomUUID();
  const mdPath = resolve(join(handoffDir, baseId + '.md'));
  const irPath = resolve(join(handoffDir, baseId + '.ir.json'));

  const lsAddress = resolveOptionString(opts, 'lsAddress') ?? textOf(process.env.ANTIGRAVITY_LS_ADDRESS);
  const csrfToken = resolveOptionString(opts, 'csrfToken') ?? textOf(process.env.ANTIGRAVITY_CSRF_TOKEN);
  const useApi = !handoffOnly && lsAddress !== undefined && csrfToken !== undefined;

  const built = buildAntigravityHandoff(bundle, {
    mdPath,
    irPath,
    title,
    cwd,
    includeChildren,
    maxChars,
  });

  const losses = new LossCollector();
  losses.add(
    'antigravity.degraded-context-handoff',
    'Antigravity 底层使用私有 Protobuf 库：已通过官方安全上下文交接方式导入（非原生历史气泡与工具卡片，完整历史见附带 .ir.json）',
    { count: root.events.length, severity: 'warning' },
  );
  if (useApi) {
    losses.add(
      'antigravity.triggers-initial-turn',
      '通过 ConversationService/CreateConversation 创建对话会立即发送首轮交接提示词并触发一次模型回复',
      { count: 1, severity: 'warning' },
    );
  } else {
    losses.add(
      'antigravity.handoff-file-only',
      '未配置 ANTIGRAVITY_LS_ADDRESS / ANTIGRAVITY_CSRF_TOKEN（或开启了 --handoff-only），仅生成本地交接文件，需手动复制提示词打开 Antigravity 续聊',
      { count: 1, severity: 'info' },
    );
  }
  if (built.omittedEvents > 0) {
    losses.add(
      'antigravity.handoff-truncated',
      '交接正文超出字符预算，已从头部省略较早事件（完整历史保存在 .ir.json）',
      { count: built.omittedEvents, severity: 'info' },
    );
  }
  if (bundle.children.length > 0) {
    if (includeChildren) {
      losses.add(
        'antigravity.subagents-summarized',
        '子代理 / swarm 子会话已摘要进交接文档（未创建独立子会话线程）',
        { count: bundle.children.length, severity: 'info' },
      );
    } else {
      losses.add(
        'antigravity.subagents-dropped',
        '子代理 / swarm 子会话未包含在内（加 --include-children 可摘要进交接文档）',
        { count: bundle.children.length, severity: 'warning' },
      );
    }
  }

  const projectId =
    resolveOptionString(opts, 'projectId') ??
    lookupAntigravityProjectId(home, cwd) ??
    textOf(process.env.ANTIGRAVITY_PROJECT_ID);

  let targetId = baseId;
  let imported = false;

  if (!dryRun) {
    mkdirSync(handoffDir, { recursive: true });
    writeFileSync(mdPath, built.markdown, 'utf8');
    writeFileSync(irPath, JSON.stringify(bundle, null, 2) + '\n', 'utf8');

    if (useApi) {
      const apiResult = await callCreateConversation({
        lsAddress: lsAddress!,
        csrfToken: csrfToken!,
        title,
        projectId,
        sourceAgent: root.source.agent,
        model,
        promptText: built.promptText,
      });
      targetId = apiResult.conversationId;
      imported = true;
    }
  }

  const delivery: 'api' | 'handoff-file' = useApi ? 'api' : 'handoff-file';
  const handoff: AntigravityHandoffInfo = {
    delivery,
    mdPath,
    irPath,
    promptText: built.promptText,
    ...(imported ? { conversationId: targetId } : {}),
    ...(projectId !== undefined ? { projectId } : {}),
  };

  const lossList: LossEntry[] = losses.sorted();
  const written = {
    events: root.events.length,
    messages: root.events.filter((e) => e.kind === 'message').length,
    toolCalls: root.events.filter((e) => e.kind === 'tool_call').length,
    toolResults: root.events.filter((e) => e.kind === 'tool_result').length,
    reasoning: root.events.filter((e) => e.kind === 'reasoning').length,
  };

  return {
    target: ANTIGRAVITY_AGENT,
    targetId,
    paths: [mdPath, irPath],
    unit: 'rows',
    units: built.mdLines,
    report: {
      target: ANTIGRAVITY_AGENT,
      sessionId: targetId,
      paths: [mdPath, irPath],
      written,
      losses: lossList,
      imported,
      delivery,
      handoff,
      caps: {
        agent: ANTIGRAVITY_AGENT,
        reasoning: 'plain',
        toolResults: 'none',
        branching: false,
        subagents: includeChildren,
        modelPinned: false,
        nativeHistory: false,
        contextHandoff: true,
        createConversationApi: useApi,
      },
    },
  };
}

function countNonEmptyLines(text: string): number {
  if (text.length === 0) return 0;
  return text.split('\n').filter((line) => line.length > 0).length;
}

export async function countAntigravityTarget(
  outcome: AdapterWriteOutcome,
  opts: AdapterWriteOptions = {},
): Promise<{ exists: boolean; units: number }> {
  const home = antigravityHome(resolveOptionString(opts, 'home'));
  const liveFile = findAntigravityTranscriptFile(home, outcome.targetId);
  if (liveFile !== undefined && existsSync(liveFile.path)) {
    return { exists: true, units: countNonEmptyLines(readFileSync(liveFile.path, 'utf8')) };
  }
  const primaryPath = outcome.paths[0];
  if (typeof primaryPath === 'string' && primaryPath.length > 0 && existsSync(primaryPath)) {
    return { exists: true, units: countNonEmptyLines(readFileSync(primaryPath, 'utf8')) };
  }
  return { exists: false, units: 0 };
}
