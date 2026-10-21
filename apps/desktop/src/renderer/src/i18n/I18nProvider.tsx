import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { enLossMessages, enNoticeMessages } from './dataMessages.ts';
import { hasMessage, interpolate, translate, type Locale, type LocalePreference, type MessageKey, type MessageParams } from './messages.ts';

export const LOCALE_STORAGE_KEY = 'sessionport.locale';

export interface DataMessage {
  code: string;
  message: string;
  count?: number;
  severity?: string;
}

export interface I18nValue {
  /** 实际生效的语言（system 偏好已经解析过） */
  locale: Locale;
  /** 用户选择：system | zh-CN | en-US */
  preference: LocalePreference;
  setPreference: (preference: LocalePreference) => void;
  t: (key: MessageKey, params?: MessageParams) => string;
  /** IPC / Error → 可展示文案；未知 code 回退到原始 message */
  tError: (error: unknown) => string;
  /** 损失清单条目（adapter 数据）→ 可展示文案 */
  tLoss: (loss: DataMessage) => string;
  /** 阅读器解读提示（adapter 数据）→ 可展示文案 */
  tNotice: (notice: DataMessage) => string;
  tDecision: (decision: string) => string;
  tSyncDescription: (decision: string, targetExtra?: number) => string;
  tMechanism: (mechanism: string) => string;
  formatTime: (iso?: string) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

export function isLocale(value: unknown): value is Locale {
  return value === 'zh-CN' || value === 'en-US';
}

export function isLocalePreference(value: unknown): value is LocalePreference {
  return value === 'system' || isLocale(value);
}

/**
 * 中文环境 → zh-CN；其余 → en-US。
 * 用 navigator.language（Electron 会按 app locale 设置）而不是写死中文。
 */
export function detectSystemLocale(): Locale {
  if (typeof navigator === 'undefined') return 'en-US';
  const primary = navigator.language || navigator.languages?.[0] || '';
  return primary.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US';
}

function readPreference(): LocalePreference {
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (isLocalePreference(stored)) return stored;
  } catch {
    // localStorage 不可用时仅内存生效
  }
  return 'system';
}

function useSystemLocale(): Locale {
  const [locale, setLocale] = useState<Locale>(detectSystemLocale);
  useEffect(() => {
    const update = (): void => setLocale(detectSystemLocale());
    window.addEventListener('languagechange', update);
    return () => window.removeEventListener('languagechange', update);
  }, []);
  return locale;
}

function toParams(value: unknown): MessageParams | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const params: MessageParams = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') params[key] = raw;
    else if (Array.isArray(raw)) params[key] = raw.map((item) => String(item)).join(', ');
  }
  return params;
}

function errorCodeOf(error: unknown): { code: string; params?: MessageParams } | null {
  if (error === null || typeof error !== 'object') return null;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== 'string' || code.length === 0) return null;
  return { code, params: toParams((error as { params?: unknown }).params) };
}

function dataText(locale: Locale, dictionary: Record<string, string>, code: string, fallback: string): string {
  if (locale === 'zh-CN') return fallback;
  const exact = dictionary[code];
  if (exact !== undefined) return exact;
  // command-code.entry-<type> 是动态拼接的 code
  if (code.startsWith('command-code.entry-')) return dictionary['command-code.entry-'] ?? fallback;
  return fallback;
}

export function I18nProvider(props: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<LocalePreference>(readPreference);
  const systemLocale = useSystemLocale();
  const locale = preference === 'system' ? systemLocale : preference;

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setPreference = useCallback((next: LocalePreference) => {
    setPreferenceState(next);
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, next);
    } catch {
      // localStorage 不可用时仅内存生效
    }
  }, []);

  const t = useCallback((key: MessageKey, params?: MessageParams): string => translate(locale, key, params), [locale]);

  const tError = useCallback(
    (error: unknown): string => {
      const failure = errorCodeOf(error);
      if (failure !== null) {
        const key = 'error.' + failure.code;
        if (hasMessage(key)) return translate(locale, key, failure.params);
      }
      const message =
        error instanceof Error ? (error.message ?? '') : error === undefined || error === null ? '' : String(error);
      if (message.length === 0) return translate(locale, 'error.unknown');
      // 兼容 preload 里没有结构化 code 的旧错误
      if (message.includes('未授权的 IPC 渠道')) return translate(locale, 'error.ipc.unauthorized');
      if (message.includes('IPC 返回格式异常')) return translate(locale, 'error.ipc.badResponse');
      // 未知 code / 来自 core 或 adapter 的错误：原样显示
      return message;
    },
    [locale],
  );

  const tLoss = useCallback(
    (loss: DataMessage): string => dataText(locale, enLossMessages, loss.code, loss.message),
    [locale],
  );

  const tNotice = useCallback(
    (notice: DataMessage): string => dataText(locale, enNoticeMessages, notice.code, notice.message),
    [locale],
  );

  const tDecision = useCallback(
    (decision: string): string => {
      const key = 'migrate.decision.' + decision;
      return hasMessage(key) ? translate(locale, key) : decision;
    },
    [locale],
  );

  const tSyncDescription = useCallback(
    (decision: string, targetExtra?: number): string => {
      const key = 'migrate.sync.' + decision;
      return hasMessage(key) ? translate(locale, key, { count: targetExtra ?? 0 }) : decision;
    },
    [locale],
  );

  const tMechanism = useCallback(
    (mechanism: string): string => {
      const key = 'migrate.official.mechanism.' + mechanism;
      return hasMessage(key) ? translate(locale, key) : mechanism;
    },
    [locale],
  );

  const formatTime = useCallback(
    (iso?: string): string => {
      if (!iso) return '—';
      const ms = Date.parse(iso);
      if (!Number.isFinite(ms)) return iso;
      return new Date(ms).toLocaleString(locale, {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
    },
    [locale],
  );

  const value = useMemo<I18nValue>(
    () => ({
      locale,
      preference,
      setPreference,
      t,
      tError,
      tLoss,
      tNotice,
      tDecision,
      tSyncDescription,
      tMechanism,
      formatTime,
    }),
    [locale, preference, setPreference, t, tError, tLoss, tNotice, tDecision, tSyncDescription, tMechanism, formatTime],
  );

  return <I18nContext.Provider value={value}>{props.children}</I18nContext.Provider>;
}

export function useT(): I18nValue {
  const value = useContext(I18nContext);
  if (value === null) throw new Error('useT must be used within I18nProvider');
  return value;
}

export { interpolate };
export type { Locale, LocalePreference, MessageKey, MessageParams };
