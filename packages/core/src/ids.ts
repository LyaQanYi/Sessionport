import { randomUUID } from 'node:crypto';

export function randomUuid(): string {
  return randomUUID();
}

/** 确定性短 id：同一份输入重复转换得到同一套 id，便于 diff */
export function stableId(prefix: string, index: number): string {
  return `${prefix}_${String(index).padStart(6, '0')}`;
}

/** Claude 风格的 assistant message id */
export function assistantMessageId(): string {
  return `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}
