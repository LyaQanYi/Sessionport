import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IR_VERSION } from '@sessionport/core';
import type { IrBundle, IrEvent, IrMessageEvent, IrNotice, IrSession } from '@sessionport/core';

import type { OpencodeExport, OpencodePart } from './wire.ts';
import { opencodeCliBinary, parseOpencodeExport, readOpencodeExportFile } from './wire.ts';

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

/**
 * 用 CLI 导出会话 JSON。
 *
 * 注意：opencode export 在 stdout 是管道时会截断到 64KB（实测），
 * 所以这里把子进程 stdout 直接接到临时文件，再读回完整内容。
 */
export async function exportOpencodeSession(sessionId: string, options: ReadOpencodeOptions = {}): Promise<OpencodeExport> {
  const binary = opencodeCliBinary(options.binary);
  const dir = mkdtempSync(join(tmpdir(), 'sessionport-opencode-export-'));
  const file = join(dir, 'export.json');
  try {
    const fd = openSync(file, 'w');
    try {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        const child = spawn(binary, ['export', sessionId, '--pure'], {
          cwd: options.cwd ?? process.cwd(),
          env: { ...process.env, ...options.env },
          stdio: ['ignore', fd, 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.on('close', (code) => {
          if (code === 0) resolvePromise();
          else rejectPromise(new Error('opencode export 失败 (exit ' + code + '): ' + stderr.slice(-800)));
        });
        child.on('error', (error) => rejectPromise(error));
      });
    } finally {
      closeSync(fd);
    }
    return parseOpencodeExport(readFileSync(file, 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 输入可以是 session id（走 CLI export）或已导出的 JSON 文件路径 */
export async function readOpencodeSession(input: string, options: ReadOpencodeOptions = {}): Promise<IrBundle> {
  const raw = input.endsWith('.json') && existsSync(input) ? readOpencodeExportFile(input) : await exportOpencodeSession(input, options);
  return exportToBundle(raw, options);
}

export function exportToBundle(raw: OpencodeExport, _options: ReadOpencodeOptions = {}): IrBundle {
  const info = raw.info ?? {};
  const messages = Array.isArray(raw.messages) ? raw.messages : [];
  const notices: IrNotice[] = [];
  const counters = { stepParts: 0, fileParts: 0, unknownParts: new Map<string, number>(), unknownBlocks: 0, missingOutput: 0 };
  const events: IrEvent[] = [];
  let index = 0;
  let lastUserText: string | undefined;

  const createdAt = msToIso(info.time?.created) ?? new Date(0).toISOString();
  const push = (event: Omit<IrEvent, 'id' | 'parentId'>, at: string): void => {
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
      const event: IrMessageEvent = { kind: 'message', at, role: 'user', parts: [{ type: 'text', text }] };
      push(event, at);
      continue;
    }

    if (messageInfo.role !== 'assistant') {
      counters.unknownBlocks += 1;
      continue;
    }

    let sawToolResultWithoutCall = false;
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
          const output = typeof state.output === 'string' ? state.output : state.error ?? '';
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
    void sawToolResultWithoutCall;
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