/**
 * ⌘K 命令面板的纯逻辑：命令构造 + 模糊匹配/打分 + 排序/分组 + 选中项移动。
 *
 * 这个模块只做数据与字符串处理，不依赖 React / Electron / i18n 运行时
 * （只有类型引用），因此可以直接在 node --test 下单测。
 *
 * 匹配档位：前缀（MATCH_PREFIX）> 词首（MATCH_WORD_START）> 子串（MATCH_SUBSTRING）。
 * 字段权重：标题/命令名 > 次要说明（路径）> 关键字（session id / agent 名）。
 */

import type { MessageKey, MessageParams } from './i18n/messages.ts';

/** 与 I18nProvider 的 t 兼容（只需要 key + 参数 → 文案） */
export type PaletteTranslate = (key: MessageKey, params?: MessageParams) => string;

export type PaletteGroup = 'sessions' | 'pages' | 'actions';

/** 页面命令能到达的视图（App 的 View 去掉 reader：阅读器需要具体会话） */
export type PaletteView = 'sessions' | 'agents' | 'migrate' | 'settings';

export type PaletteActionId = 'refresh-sessions' | 'cycle-theme' | 'open-settings';

export type PaletteTheme = 'system' | 'light' | 'dark';

/** 会话命令只需要这几个字段，避免纯逻辑模块把 api.ts 拖进来 */
export interface PaletteSession {
  agent: string;
  sessionId: string;
  title?: string;
  cwd?: string;
  nativePath?: string;
  updatedAt?: string;
  readable?: boolean;
}

export interface PaletteCommand<T extends PaletteSession = PaletteSession> {
  id: string;
  group: PaletteGroup;
  /** 主文案（已本地化） */
  label: string;
  /** 次级说明：路径 / session id / 主题状态 */
  hint?: string;
  /** 参与匹配但不展示的补充文本（session id、agent 名等） */
  keywords?: string[];
  /** 页面命令的目标 view */
  view?: PaletteView;
  /** 操作命令的标识 */
  action?: PaletteActionId;
  /** 会话命令携带原始行 */
  session?: T;
}

/** 分组展示顺序（需求里的「会话 / 页面 / 操作」） */
export const PALETTE_GROUP_ORDER: readonly PaletteGroup[] = ['sessions', 'pages', 'actions'];

export const MATCH_PREFIX = 100;
export const MATCH_WORD_START = 60;
export const MATCH_SUBSTRING = 30;

const LABEL_WEIGHT = 1;
const HINT_WEIGHT = 0.6;
const KEYWORD_WEIGHT = 0.5;

/** 词首判定：前面是空白或常见路径/命名分隔符 */
const WORD_SEPARATOR = /[\s/\\\-_.:·|>]+/;

/** 查询串 → 小写 token（多个 token 之间是 AND 关系） */
export function tokenize(query: string): string[] {
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

function isWordStart(text: string, index: number): boolean {
  if (index <= 0) return true;
  return WORD_SEPARATOR.test(text[index - 1] ?? '');
}

function matchTier(text: string, token: string): number {
  if (token.length === 0) return 0;
  const haystack = text.toLowerCase();
  let best = 0;
  let from = 0;
  while (from <= haystack.length - token.length) {
    const index = haystack.indexOf(token, from);
    if (index === -1) break;
    if (index === 0) return MATCH_PREFIX;
    best = Math.max(best, isWordStart(haystack, index) ? MATCH_WORD_START : MATCH_SUBSTRING);
    if (best === MATCH_WORD_START) return best;
    from = index + 1;
  }
  return best;
}

/** 单字段打分：0 表示不匹配 */
export function scoreText(text: string, token: string): number {
  return matchTier(text, token);
}

interface SearchField {
  text: string;
  weight: number;
}

function fieldsOf(command: PaletteCommand): SearchField[] {
  const fields: SearchField[] = [{ text: command.label, weight: LABEL_WEIGHT }];
  if (command.hint) fields.push({ text: command.hint, weight: HINT_WEIGHT });
  for (const keyword of command.keywords ?? []) {
    if (keyword.length > 0) fields.push({ text: keyword, weight: KEYWORD_WEIGHT });
  }
  return fields;
}

/** 命令打分：每个 token 都必须命中某个字段；全部命中才返回分数，否则 null */
export function scoreCommand(command: PaletteCommand, query: string): number | null {
  const tokens = tokenize(query);
  if (tokens.length === 0) return 0;
  const fields = fieldsOf(command);
  let total = 0;
  for (const token of tokens) {
    let best = 0;
    for (const field of fields) {
      const tier = matchTier(field.text, token);
      if (tier === 0) continue;
      const weighted = tier * field.weight;
      if (weighted > best) best = weighted;
    }
    if (best === 0) return null;
    total += best;
  }
  return total;
}

/** 过滤 + 排序（同分保持原有顺序：会话按 updatedAt 倒序、页面/操作按定义顺序） */
export function rankCommands<T extends PaletteSession>(
  commands: readonly PaletteCommand<T>[],
  query: string,
): PaletteCommand<T>[] {
  const scored: Array<{ command: PaletteCommand<T>; score: number; index: number }> = [];
  commands.forEach((command, index) => {
    const score = scoreCommand(command, query);
    if (score === null) return;
    scored.push({ command, score, index });
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map((entry) => entry.command);
}

export interface VisibleOptions {
  /** 有查询串时会话组最多保留多少条 */
  maxSessions?: number;
  /** 查询串为空时会话组最多保留多少条（最近使用优先） */
  maxSessionsWhenEmpty?: number;
}

/** 分组在渲染/键盘导航里的顺序索引 */
function groupRank(group: PaletteGroup): number {
  const index = PALETTE_GROUP_ORDER.indexOf(group);
  return index === -1 ? PALETTE_GROUP_ORDER.length : index;
}

/**
 * 真正渲染的扁平列表：顺序 = 分组展示顺序（组内按分数），再给会话组做上限。
 *
 * 顺序必须和渲染顺序一致：键盘选中项、aria-activedescendant 都用这个下标。
 * 页面/操作只有几条，不截断（避免「昨天还在用的命令今天搜不到」）。
 */
export function visibleCommands<T extends PaletteSession>(
  commands: readonly PaletteCommand<T>[],
  query: string,
  options: VisibleOptions = {},
): PaletteCommand<T>[] {
  const ranked = rankCommands(commands, query).sort(
    (a, b) => groupRank(a.group) - groupRank(b.group),
  );
  const empty = tokenize(query).length === 0;
  const limit = empty ? (options.maxSessionsWhenEmpty ?? 6) : (options.maxSessions ?? 30);
  const result: PaletteCommand<T>[] = [];
  let sessions = 0;
  for (const command of ranked) {
    if (command.group === 'sessions') {
      if (sessions >= limit) continue;
      sessions += 1;
    }
    result.push(command);
  }
  return result;
}

export interface PaletteSection<T extends PaletteSession = PaletteSession> {
  group: PaletteGroup;
  commands: PaletteCommand<T>[];
}

/** 按固定顺序分组，空分组不出现 */
export function groupCommands<T extends PaletteSession>(
  commands: readonly PaletteCommand<T>[],
  order: readonly PaletteGroup[] = PALETTE_GROUP_ORDER,
): PaletteSection<T>[] {
  const sections: PaletteSection<T>[] = [];
  for (const group of order) {
    const items = commands.filter((command) => command.group === group);
    if (items.length > 0) sections.push({ group, commands: items });
  }
  return sections;
}

/** ↑↓ 移动选中项，循环；列表为空时返回 0 */
export function stepSelection(current: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  const next = (current + delta) % count;
  return next < 0 ? next + count : next;
}

/** 命令列表变化后把选中项夹到合法范围 */
export function clampSelection(index: number, count: number): number {
  if (count <= 0) return -1;
  if (index < 0) return 0;
  return Math.min(index, count - 1);
}

/** 主题循环：system → light → dark → system */
export function nextTheme(theme: PaletteTheme): PaletteTheme {
  if (theme === 'system') return 'light';
  if (theme === 'light') return 'dark';
  return 'system';
}

export function themeMessageKey(theme: PaletteTheme): MessageKey {
  if (theme === 'light') return 'theme.light';
  if (theme === 'dark') return 'theme.dark';
  return 'theme.system';
}

interface PageDefinition {
  view: PaletteView;
  labelKey: MessageKey;
  keywords: string[];
}

const PAGE_DEFINITIONS: readonly PageDefinition[] = [
  { view: 'sessions', labelKey: 'nav.sessions', keywords: ['session', 'sessions', 'list', '会话', '列表'] },
  { view: 'agents', labelKey: 'nav.agents', keywords: ['agent', 'agents', 'adapter', 'adapters', '适配器', 'harness'] },
  { view: 'migrate', labelKey: 'nav.migrate', keywords: ['migrate', 'migration', 'port', '迁移'] },
  { view: 'settings', labelKey: 'app.settings', keywords: ['settings', 'preferences', 'config', '设置'] },
];

/** 页面命令：会话 / 适配器 / 迁移 / 设置（复用现有导航回调） */
export function buildPageCommands<T extends PaletteSession = PaletteSession>(t: PaletteTranslate): PaletteCommand<T>[] {
  return PAGE_DEFINITIONS.map((page) => ({
    id: 'page:' + page.view,
    group: 'pages' as const,
    label: t(page.labelKey),
    keywords: page.keywords,
    view: page.view,
  }));
}

/** 操作命令：刷新会话列表 / 切换主题 / 打开设置 */
export function buildActionCommands<T extends PaletteSession = PaletteSession>(
  t: PaletteTranslate,
  theme: PaletteTheme,
): PaletteCommand<T>[] {
  const upcoming = nextTheme(theme);
  return [
    {
      id: 'action:refresh-sessions',
      group: 'actions' as const,
      label: t('palette.action.refreshSessions'),
      keywords: ['refresh', 'reload', 'rescan', 'sync', '刷新'],
      action: 'refresh-sessions' as const,
    },
    {
      id: 'action:cycle-theme',
      group: 'actions' as const,
      label: t('palette.action.cycleTheme'),
      hint: t('palette.action.cycleThemeHint', {
        current: t(themeMessageKey(theme)),
        next: t(themeMessageKey(upcoming)),
      }),
      keywords: ['theme', 'appearance', 'dark', 'light', 'system', '主题', '深浅色'],
      action: 'cycle-theme' as const,
    },
    {
      id: 'action:open-settings',
      group: 'actions' as const,
      label: t('palette.action.openSettings'),
      keywords: ['settings', 'preferences', '设置'],
      action: 'open-settings' as const,
    },
  ];
}

/** 会话命令：标题（缺省用 sessionId）+ 路径说明；按 updatedAt 倒序 */
export function buildSessionCommands<T extends PaletteSession>(
  sessions: readonly T[],
  options: { agentLabel?: (agent: string) => string } = {},
): PaletteCommand<T>[] {
  const labelOf = options.agentLabel ?? ((agent: string): string => agent);
  return [...sessions]
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
    .map((session) => {
      const title = session.title?.trim();
      const label = title !== undefined && title.length > 0 ? title : session.sessionId;
      const agentName = labelOf(session.agent);
      const keywords = [session.sessionId, session.nativePath ?? '', agentName, session.agent].filter(
        (keyword) => keyword.length > 0,
      );
      return {
        id: 'session:' + session.agent + ':' + session.sessionId + ':' + (session.nativePath ?? ''),
        group: 'sessions' as const,
        label,
        hint: session.cwd ?? session.nativePath,
        keywords,
        session,
      };
    });
}

export interface BuildCommandsOptions<T extends PaletteSession> {
  sessions: readonly T[];
  t: PaletteTranslate;
  theme: PaletteTheme;
  agentLabel?: (agent: string) => string;
}

/** 三组命令的完整列表（会话 → 页面 → 操作） */
export function buildCommands<T extends PaletteSession>(options: BuildCommandsOptions<T>): PaletteCommand<T>[] {
  return [
    ...buildSessionCommands(options.sessions, { agentLabel: options.agentLabel }),
    ...buildPageCommands<T>(options.t),
    ...buildActionCommands<T>(options.t, options.theme),
  ];
}

/** 命令 → 执行意图；UI 只负责把意图映射到回调 */
export type PaletteIntent<T extends PaletteSession = PaletteSession> =
  | { kind: 'open-session'; session: T }
  | { kind: 'navigate'; view: PaletteView }
  | { kind: 'action'; action: PaletteActionId };

export function resolveCommand<T extends PaletteSession>(command: PaletteCommand<T>): PaletteIntent<T> | null {
  if (command.session) return { kind: 'open-session', session: command.session };
  if (command.view) return { kind: 'navigate', view: command.view };
  if (command.action) return { kind: 'action', action: command.action };
  return null;
}
