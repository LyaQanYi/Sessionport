/**
 * sessionport IR v0.1
 *
 * 设计目标：把四家 agent 的会话归一成「可追加的事件流 + 链式 parent」，
 * 并且保证任何源端特有能力在这里都能表达或至少显式记为损失。
 *
 * 约定：
 * - 所有时间戳统一 ISO 8601（源端毫秒/秒时间戳在 adapter 里转换）
 * - 事件顺序即文件顺序，parentId 指向上一事件，构成链
 * - _native 保存源端原始 payload，导出回同一家时可无损还原（跨家导出时忽略）
 */

export const IR_VERSION = '0.1' as const;

export type AgentId = 'claude-code' | 'codex' | 'opencode' | 'kimi-code' | 'command-code' | 'dsh';

/** 来源指纹：版本登记制与回归测试的依据 */
export interface SourceFingerprint {
  agent: AgentId;
  /** 该 agent CLI / 桌面端版本，探测不到就留空 */
  cliVersion?: string;
  /** 会话格式版本（Kimi state.version、opencode session.version 等） */
  formatVersion?: string;
  /** 协议版本（Kimi protocol_version 这类） */
  protocolVersion?: string;
  /** 源端原生会话 id */
  nativeSessionId?: string;
  /** 源端路径（目录或文件），便于追溯 */
  nativePath?: string;
}

export interface IrMeta {
  cwd?: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  model?: string;
  /** agent profile / 模式，如 kimi 的 main、opencode 的 build */
  profile?: string;
  archived?: boolean;
  lastPrompt?: string;
}

/**
 * 拉取侧的提示信息：源端有、IR 里没有对应概念，或解析时做了取舍。
 * 与导出的损失清单分开：notices 记录「读进来时丢了什么」，
 * losses 记录「写出去时丢了什么」。
 */
export interface IrNotice {
  code: string;
  message: string;
  count?: number;
  severity: 'info' | 'warning';
}

export interface IrEventBase {
  id: string;
  parentId: string | null;
  /** ISO 8601 */
  at: string;
  /** 源端原始事件，用于无损往返；跨家导出时忽略 */
  _native?: unknown;
}

export interface IrMessageEvent extends IrEventBase {
  kind: 'message';
  role: 'user' | 'assistant';
  parts: IrPart[];
  /** 源端运行时注入的消息（如 Kimi 的 system-reminder），导出到目标端时可标记为 meta */
  synthetic?: boolean;
}

export interface IrReasoningEvent extends IrEventBase {
  kind: 'reasoning';
  reasoning: IrReasoning;
}

export interface IrToolCallEvent extends IrEventBase {
  kind: 'tool_call';
  /** 统一后的工具调用 id */
  callId: string;
  name: string;
  input: unknown;
}

export interface IrToolResultEvent extends IrEventBase {
  kind: 'tool_result';
  callId: string;
  content: IrContent[];
  isError?: boolean;
}

/** 分支 / 撤销 / 压缩 / 取消等边界，目标端接不住时进损失清单 */
export interface IrBoundaryEvent extends IrEventBase {
  kind: 'boundary';
  boundary: 'fork' | 'undo' | 'compact' | 'cancel';
  detail?: string;
}

export type IrEvent =
  | IrMessageEvent
  | IrReasoningEvent
  | IrToolCallEvent
  | IrToolResultEvent
  | IrBoundaryEvent;

export type IrPart =
  | { type: 'text'; text: string }
  | { type: 'image'; ref: string };

export type IrReasoning =
  | { kind: 'plain'; text: string; signature?: string }
  | { kind: 'opaque'; payload: unknown; format?: string };

export type IrContent =
  | { type: 'text'; text: string }
  | { type: 'json'; value: unknown }
  | { type: 'diff'; text: string }
  | { type: 'terminal'; text: string }
  | { type: 'image'; ref: string };

export interface IrSession {
  /** IR 内部 id */
  id: string;
  source: SourceFingerprint;
  meta: IrMeta;
  events: IrEvent[];
  /** 链尾事件 id */
  head: string | null;
  notices: IrNotice[];
}

/** 子代理会话：独立 session + parent 边（四家通用模型） */
export interface IrChildSession {
  session: IrSession;
  parentSessionId: string;
  /** 触发子代理的那个工具调用 */
  viaToolCallId?: string;
  /** 子代理 profile 名，如 explore */
  label?: string;
}

export interface IrBundle {
  irVersion: typeof IR_VERSION;
  createdAt: string;
  root: IrSession;
  children: IrChildSession[];
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

export function eventKindCounts(session: IrSession): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of session.events) out[e.kind] = (out[e.kind] ?? 0) + 1;
  return out;
}

export function bundleEventCount(bundle: IrBundle): number {
  return bundle.children.reduce((n, c) => n + c.session.events.length, bundle.root.events.length);
}

export function isPlainReasoning(r: IrReasoning): r is Extract<IrReasoning, { kind: 'plain' }> {
  return r.kind === 'plain';
}

export function contentToText(content: IrContent[]): string {
  return content
    .map((c) => {
      switch (c.type) {
        case 'text':
        case 'diff':
        case 'terminal':
          return c.text;
        case 'image':
          return `[image: ${c.ref}]`;
        case 'json':
          return JSON.stringify(c.value);
      }
    })
    .join('\n');
}

/** 轻量结构校验：不引依赖，先保证 CLI 不会吃到明显坏数据 */
export function validateIrBundle(value: unknown): string[] {
  const errors: string[] = [];
  const b = value as Partial<IrBundle> | null;
  if (!b || typeof b !== 'object') return ['bundle 不是对象'];
  if (b.irVersion !== IR_VERSION) errors.push(`irVersion 不是 ${IR_VERSION}: ${String(b.irVersion)}`);
  if (!b.root || typeof b.root !== 'object') errors.push('缺少 root session');
  const check = (s: IrSession | undefined, label: string): void => {
    if (!s) return;
    if (typeof s.id !== 'string' || !s.id) errors.push(`${label}.id 缺失`);
    if (!Array.isArray(s.events)) errors.push(`${label}.events 不是数组`);
    else {
      let prev: string | null = null;
      for (const e of s.events) {
        if (typeof e.id !== 'string' || !e.id) errors.push(`${label} 有事件缺 id`);
        if (e.parentId !== prev) errors.push(`${label} 事件链断裂: ${e.id} parentId=${String(e.parentId)} 期望 ${String(prev)}`);
        prev = e.id;
      }
      if (s.head !== prev) errors.push(`${label}.head=${String(s.head)} 与链尾 ${String(prev)} 不一致`);
    }
  };
  if (b.root) check(b.root, 'root');
  if (Array.isArray(b.children)) b.children.forEach((c, i) => check(c?.session, `children[${i}]`));
  return errors;
}