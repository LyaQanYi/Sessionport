/**
 * 主进程里的结构化错误：code 给 renderer 做 i18n 映射，message 保留中文原文
 * 作为向后兼容（旧 renderer / 未知 code 直接展示）。
 *
 * params 必须可结构化克隆（string / number / boolean / 数组 / 普通对象）。
 */
export class AppError extends Error {
  readonly code: string;
  readonly params?: Record<string, unknown>;

  constructor(code: string, message: string, params?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    if (params !== undefined) this.params = params;
  }
}
