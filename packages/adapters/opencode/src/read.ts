import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IR_VERSION } from '@sessionport/core';
import type { IrBundle, IrContent, IrEvent, IrEventInput, IrNotice, IrSession } from '@sessionport/core';

import type { OpencodeExport, OpencodePart, OpencodeV2ContentBlock, OpencodeV2Message } from './wire.ts';
import {
  detectOpencodeCliVersion,
  detectOpencodeExportFormat,
  opencodeCliBinary,
  opencodeExportArgs,
  parseOpencodeExport,
  readOpencodeExportFile,
} from './wire.ts';

export interface ReadOpencodeOptions {
  /** opencode CLI 路径 */
  binary?: string;
  /** 额外环境变量（隔离 OPENCODE_DB / XDG_DATA_HOME 等） */
  env?: Record<string, string>;
  /** 子进程 cwd（opencode 可能依赖它解析项目） */
  cwd?: string;
}

export interface ReadOpencodeResult {
  bundle: IrBundle;
  raw: OpencodeExport;
}

function msToIso(ms: unknown): string | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

function partAt(part: OpencodePart, fallback: string): string {
  return msToIso(part.time?.start) ?? msToIso(part.time?.end) ?? fallback;
}

function blockAt(block: OpencodeV2ContentBlock, fallback: string): string {
  return msToIso(block.time?.created) ?? msToIso(block.time?.ran) ?? msToIso(block.time?.start) ?? msToIso(block.time?.completed) ?? msToIso(block.time?.end) ?? fallback;
}

function runExportCommand(binary: string, args: string[], file: string, options: ReadOpencodeOptions): Promise<void> {
  const fd = openSync(file, 'w');
  return new Promise<void>((resolvePromise, rejectPromise) => {
    let closed = false;
    const closeFd = (): void => {
      if (closed) return;
      closed = true;
      closeSync(fd);
    };
    const child = spawn(binary, args, {
      cwd: options.cwd ?? process.cwd(),
      env: { ...process.env, ...options.env },
      stdio: ['ignore', fd, 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('close', (code) => {
      closeFd();
      if (code === 0) resolvePromise();
      else rejectPromise(new Error('opencode ' + args.slice(0, 2).join(' ') + ' 失败 (exit ' + code + '): ' + stderr.slice(-800)));
    });
    child.on('error', (error) => {
      closeFd();
      rejectPromise(error);
    });
  });
}

function shouldStopFallback(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') return true;
  const message = error instanceof Error ? error.message : String(error);
  return /Session not found/i.test(message);
}

/**
 * 用 CLI 导出会话 JSON（兼容 1.x `export <id> --pure` 与 2.x `session export --standalone <id>`）。
 *
 * 注意：1.x 的 opencode export 在 stdout 是管道时会截断到 64KB（实测），
 * 所以这里统一把子进程 stdout 直接接到临时文件，再读回完整内容。
 */
export async function exportOpencodeSession(sessionId: string, options: ReadOpencodeOptions = {}): Promise<OpencodeExport> {
  const binary = opencodeCliBinary(options.binary);
  const version = await detectOpencodeCliVersion(binary, options.env);
  const candidates: string[][] =
    version?.major !== undefined
      ? [opencodeExportArgs(sessionId, version.major >= 2 ? 'v2' : 'v1')]
      : [opencodeExportArgs(sessionId, 'v2'), opencodeExportArgs(sessionId, 'v1')];

  const dir = mkdtempSync(join(tmpdir(), 'sessionport-opencode-export-'));
  const file = join(dir, 'export.json');
  try {
    let lastError: unknown;
    for (let index = 0; index < candidates.length; index += 1) {
      try {
        await runExportCommand(binary, candidates[index]!, file, options);
        return parseOpencodeExport(readFileSync(file, 'utf8'));
      } catch (error) {
        lastError = error;
        if (index + 1 >= candidates.length || shouldStopFallback(error)) throw error;
      }
    }
    throw lastError;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 输入可以是 session id（走 CLI export）或已导出的 JSON 文件路径 */
export async function readOpencodeSession(input: string, options: ReadOpencodeOptions = {}): Promise<IrBundle> {
  const raw = input.endsWith('.json') && existsSync(input) ? readOpencodeExportFile(input) : await exportOpencodeSession(input, options);
  return exportToBundle(raw, options);
}

function extractV2ToolContent(items: unknown): IrContent[] {
  if (!Array.isArray(items) || items.length === 0) return [{ type: 'text', text: '' }];
  const out: IrContent[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') {
      out.push({ type: 'text', text: String(item ?? '') });
      continue;
    }
    const record = item as Record<string, unknown>;
    if (record.type === 'text' && typeof record.text === 'string') {
      out.push({ type: 'text', text: record.text });
    } else if (record.type === 'image') {
      const ref = typeof record.url === 'string' ? record.url : typeof record.ref === 'string' ? record.ref : 'image';
      out.push({ type: 'image', ref });
    } else {
      out.push({ type: 'json', value: item });
    }
  }
  return out.length > 0 ? out : [{ type: 'text', text: '' }];
}

function extractV2ToolError(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    if (typeof record.message === 'string') return record.message;
    return JSON.stringify(error);
  }
  return '';
}

function exportV2ToBundle(raw: OpencodeExport): IrBundle {
  const info = raw.info ?? {};
  const messages = Array.isArray(raw.messages) ? (raw.messages as OpencodeV2Message[]) : [];
  const notices: IrNotice[] = [];
  const counters = {
    runtimeMessages: 0,
    syntheticMessages: 0,
    assistantErrors: 0,
    fileParts: 0,
    unknownParts: new Map<string, number>(),
    unknownBlocks: 0,
    missingOutput: 0,
  };
  const events: IrEvent[] = [];
  let index = 0;
  let firstUserText: string | undefined;

  const createdAt = msToIso(info.time?.created) ?? new Date(0).toISOString();
  const push = (event: IrEventInput, at: string): void => {
    index += 1;
    events.push({
      ...(event as IrEvent),
      id: 'oc:e' + String(index).padStart(6, '0'),
      parentId: events.length > 0 ? events[events.length - 1]!.id : null,
      at,
    } as IrEvent);
  };

  for (const message of messages) {
    const type = message.type ?? '';
    const at = msToIso(message.time?.created) ?? createdAt;

    if (type === 'user') {
      if (Array.isArray(message.files) && message.files.length > 0) {
        counters.fileParts += message.files.length;
      }
      const text = typeof message.text === 'string' ? message.text : '';
      if (text.length === 0) continue;
      if (firstUserText === undefined) firstUserText = text;
      push({ kind: 'message', at, role: 'user', parts: [{ type: 'text', text }] }, at);
      continue;
    }

    if (type === 'synthetic' || type === 'system') {
      const text = typeof message.text === 'string' ? message.text : '';
      if (text.length === 0) {
        counters.runtimeMessages += 1;
        continue;
      }
      counters.syntheticMessages += 1;
      push({ kind: 'message', at, role: 'user', parts: [{ type: 'text', text }], synthetic: true }, at);
      continue;
    }

    if (type === 'idle' || type === 'model-switched' || type === 'agent-switched') {
      counters.runtimeMessages += 1;
      continue;
    }

    if (type !== 'assistant') {
      counters.unknownBlocks += 1;
      continue;
    }

    const blocks = Array.isArray(message.content) ? message.content : [];
    if (blocks.length === 0 && message.finish === 'error' && message.error !== undefined) {
      counters.assistantErrors += 1;
      continue;
    }

    for (const block of blocks) {
      const blockType = block.type ?? '';
      if (blockType === 'text') {
        if (typeof block.text === 'string' && block.text.length > 0) {
          const textAt = blockAt(block, at);
          push({ kind: 'message', at: textAt, role: 'assistant', parts: [{ type: 'text', text: block.text }] }, textAt);
        }
        continue;
      }
      if (blockType === 'reasoning') {
        const signature = typeof block.state?.signature === 'string' ? block.state.signature : undefined;
        const text = typeof block.text === 'string' ? block.text : '';
        if (text.length > 0 || signature !== undefined) {
          const reasoningAt = blockAt(block, at);
          push(
            { kind: 'reasoning', at: reasoningAt, reasoning: { kind: 'plain', text, ...(signature === undefined ? {} : { signature }) } },
            reasoningAt,
          );
        }
        continue;
      }
      if (blockType === 'tool') {
        const callId = String(block.id ?? '');
        const toolAt = msToIso(block.time?.created) ?? msToIso(block.time?.ran) ?? at;
        const resultAt = msToIso(block.time?.completed) ?? toolAt;
        const state = block.state ?? {};
        push({ kind: 'tool_call', at: toolAt, callId, name: String(block.name ?? 'unknown'), input: state.input ?? {} }, toolAt);
        if (state.status === 'completed') {
          push({ kind: 'tool_result', at: resultAt, callId, content: extractV2ToolContent(state.content), isError: false }, resultAt);
        } else if (state.status === 'error') {
          const errorText = extractV2ToolError(state.error);
          push({ kind: 'tool_result', at: resultAt, callId, content: [{ type: 'text', text: errorText }], isError: true }, resultAt);
        } else {
          counters.missingOutput += 1;
        }
        continue;
      }
      if (blockType === 'file') {
        counters.fileParts += 1;
        continue;
      }
      counters.unknownParts.set(blockType, (counters.unknownParts.get(blockType) ?? 0) + 1);
    }
  }

  if (counters.runtimeMessages > 0) {
    notices.push({
      code: 'opencode.runtime-messages-skipped',
      message: 'idle / model-switched / agent-switched 是运行时状态消息，不属于对话内容，已跳过',
      count: counters.runtimeMessages,
      severity: 'info',
    });
  }
  if (counters.syntheticMessages > 0) {
    notices.push({
      code: 'opencode.synthetic-message',
      message: 'opencode 运行时注入的 synthetic/system 消息已标记 synthetic',
      count: counters.syntheticMessages,
      severity: 'info',
    });
  }
  if (counters.assistantErrors > 0) {
    notices.push({
      code: 'opencode.assistant-error-skipped',
      message: '空的 assistant 错误回合（如上游配额/限流报错）已跳过',
      count: counters.assistantErrors,
      severity: 'info',
    });
  }
  if (counters.missingOutput > 0) {
    notices.push({
      code: 'opencode.tool-without-output',
      message: '工具调用没有完成态输出（进行中或被打断），只保留了调用',
      count: counters.missingOutput,
      severity: 'warning',
    });
  }
  if (counters.fileParts > 0) {
    notices.push({
      code: 'opencode.file-parts-skipped',
      message: 'file 类型的 part / 附件未映射进 IR',
      count: counters.fileParts,
      severity: 'warning',
    });
  }
  if (counters.unknownBlocks > 0) {
    notices.push({
      code: 'opencode.unknown-message-role',
      message: '未识别的消息类型已跳过',
      count: counters.unknownBlocks,
      severity: 'warning',
    });
  }
  for (const [type, count] of counters.unknownParts) {
    notices.push({ code: 'opencode.unknown-part', message: '未识别的 part 类型 ' + type, count, severity: 'warning' });
  }

  const directory = info.location?.directory ?? info.directory;
  const modelId = info.model?.id ?? info.model?.modelID ?? undefined;
  const session: IrSession = {
    id: 'opencode:' + String(info.id ?? 'unknown'),
    source: {
      agent: 'opencode',
      nativeSessionId: info.id,
      nativePath: directory,
      formatVersion: info.version ?? '2',
    },
    meta: {
      cwd: directory,
      title: info.title ?? firstUserText?.slice(0, 60),
      createdAt,
      updatedAt: msToIso(info.time?.updated),
      model: modelId,
      profile: info.agent,
    },
    events,
    head: events.length > 0 ? events[events.length - 1]!.id : null,
    notices,
  };

  return { irVersion: IR_VERSION, createdAt: new Date().toISOString(), root: session, children: [] };
}

export function exportToBundle(raw: OpencodeExport, _options: ReadOpencodeOptions = {}): IrBundle {
  if (detectOpencodeExportFormat(raw) === 'v2') {
    return exportV2ToBundle(raw);
  }

  const info = raw.info ?? {};
  const messages = Array.isArray(raw.messages) ? raw.messages : [];
  const notices: IrNotice[] = [];
  const counters = { stepParts: 0, fileParts: 0, unknownParts: new Map<string, number>(), unknownBlocks: 0, missingOutput: 0 };
  const events: IrEvent[] = [];
  let index = 0;
  let lastUserText: string | undefined;

  const createdAt = msToIso(info.time?.created) ?? new Date(0).toISOString();
  const push = (event: IrEventInput, at: string): void => {
    index += 1;
    events.push({ ...(event as IrEvent), id: 'oc:e' + String(index).padStart(6, '0'), parentId: events.length > 0 ? events[events.length - 1]!.id : null, at } as IrEvent);
  };

  for (const message of messages) {
    const messageInfo = message.info ?? {};
    const at = msToIso(messageInfo.time?.created) ?? createdAt;
    if (messageInfo.role === 'user') {
      const texts: string[] = [];
      for (const part of message.parts ?? []) {
        if (part.type === 'text' && typeof part.text === 'string' && part.text.length > 0) texts.push(part.text);
      }
      if (texts.length === 0) continue;
      const text = texts.join('\n');
      if (lastUserText === undefined) lastUserText = text;
      const event: IrEventInput = { kind: 'message', at, role: 'user', parts: [{ type: 'text', text }] };
      push(event, at);
      continue;
    }

    if (messageInfo.role !== 'assistant') {
      counters.unknownBlocks += 1;
      continue;
    }

    for (const part of message.parts ?? []) {
      const partType = part.type ?? '';
      if (partType === 'text') {
        if (typeof part.text === 'string' && part.text.length > 0) {
          push({ kind: 'message', at: partAt(part, at), role: 'assistant', parts: [{ type: 'text', text: part.text }] }, partAt(part, at));
        }
        continue;
      }
      if (partType === 'reasoning') {
        const signature = (part.metadata as { anthropic?: { signature?: string } } | undefined)?.anthropic?.signature;
        const text = typeof part.text === 'string' ? part.text : '';
        if (text.length > 0 || signature !== undefined) {
          push({ kind: 'reasoning', at: partAt(part, at), reasoning: { kind: 'plain', text, ...(signature === undefined ? {} : { signature }) } }, partAt(part, at));
        }
        continue;
      }
      if (partType === 'tool') {
        const callId = String(part.callID ?? part.id ?? '');
        const toolAt = partAt(part, at);
        push({ kind: 'tool_call', at: toolAt, callId, name: String(part.tool ?? 'unknown'), input: part.state?.input ?? {} }, toolAt);
        const state = part.state ?? {};
        if (state.status === 'completed' || state.status === 'error') {
          const output = typeof state.output === 'string' ? state.output : typeof state.error === 'string' ? state.error : '';
          push({ kind: 'tool_result', at: toolAt, callId, content: [{ type: 'text', text: output }], isError: state.status === 'error' }, toolAt);
        } else {
          counters.missingOutput += 1;
        }
        continue;
      }
      if (partType === 'step-start' || partType === 'step-finish') {
        counters.stepParts += 1;
        continue;
      }
      if (partType === 'file') {
        counters.fileParts += 1;
        continue;
      }
      counters.unknownParts.set(partType, (counters.unknownParts.get(partType) ?? 0) + 1);
    }
  }

  if (counters.stepParts > 0) {
    notices.push({ code: 'opencode.step-parts-skipped', message: 'step-start/step-finish 是流式占位，不属于对话内容，已跳过', count: counters.stepParts, severity: 'info' });
  }
  if (counters.missingOutput > 0) {
    notices.push({ code: 'opencode.tool-without-output', message: '工具调用没有完成态输出（进行中或被打断），只保留了调用', count: counters.missingOutput, severity: 'warning' });
  }
  if (counters.fileParts > 0) {
    notices.push({ code: 'opencode.file-parts-skipped', message: 'file 类型的 part（附件/快照）未映射进 IR', count: counters.fileParts, severity: 'warning' });
  }
  if (counters.unknownBlocks > 0) {
    notices.push({ code: 'opencode.unknown-message-role', message: '非 user/assistant 的消息已跳过', count: counters.unknownBlocks, severity: 'warning' });
  }
  for (const [type, count] of counters.unknownParts) {
    notices.push({ code: 'opencode.unknown-part', message: '未识别的 part 类型 ' + type, count, severity: 'warning' });
  }

  const modelId = info.model?.id ?? undefined;
  const session: IrSession = {
    id: 'opencode:' + String(info.id ?? 'unknown'),
    source: {
      agent: 'opencode',
      nativeSessionId: info.id,
      nativePath: info.directory,
      formatVersion: info.version,
    },
    meta: {
      cwd: info.directory,
      title: info.title ?? lastUserText?.slice(0, 60),
      createdAt,
      updatedAt: msToIso(info.time?.updated),
      model: modelId,
      profile: info.agent,
    },
    events,
    head: events.length > 0 ? events[events.length - 1]!.id : null,
    notices,
  };

  return { irVersion: IR_VERSION, createdAt: new Date().toISOString(), root: session, children: [] };
}
