import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MATCH_PREFIX,
  MATCH_SUBSTRING,
  MATCH_WORD_START,
  buildActionCommands,
  buildCommands,
  buildPageCommands,
  buildSessionCommands,
  clampSelection,
  groupCommands,
  nextTheme,
  rankCommands,
  resolveCommand,
  scoreCommand,
  scoreText,
  stepSelection,
  themeMessageKey,
  tokenize,
  visibleCommands,
} from '../src/renderer/src/commandPalette.ts';
import type { PaletteCommand, PaletteSession } from '../src/renderer/src/commandPalette.ts';
import type { MessageKey } from '../src/renderer/src/i18n/messages.ts';

/** 测试用伪 t：不依赖 i18n 运行时，键名即文案 */
function fakeT(key: MessageKey, params?: Record<string, unknown>): string {
  if (params === undefined) return key;
  return key + '(' + Object.entries(params).map(([name, value]) => name + '=' + String(value)).join(',') + ')';
}

const SESSIONS: PaletteSession[] = [
  {
    agent: 'codex',
    sessionId: 'rollout-001',
    title: 'Fix login bug',
    cwd: '/work/sessionport',
    nativePath: '/work/sessionport/.codex/rollout-001.jsonl',
    updatedAt: '2026-03-02T10:00:00.000Z',
    readable: true,
  },
  {
    agent: 'claude-code',
    sessionId: 'abc-123',
    title: 'Session port plan',
    cwd: '/work/notes',
    nativePath: '/home/.claude/projects/notes/abc-123.jsonl',
    updatedAt: '2026-03-01T10:00:00.000Z',
    readable: true,
  },
  {
    agent: 'kimi-code',
    sessionId: 'kimi-9',
    nativePath: '/home/.kimi/sessions/kimi-9.json',
    updatedAt: '2026-02-28T10:00:00.000Z',
    readable: false,
  },
];

function command(partial: Partial<PaletteCommand> & Pick<PaletteCommand, 'id' | 'label'>): PaletteCommand {
  return { group: 'sessions', ...partial };
}

test('commandPalette：tokenize 去空白、转小写、拆 token', () => {
  assert.deepEqual(tokenize('  Fix   LOGIN '), ['fix', 'login']);
  assert.deepEqual(tokenize('   '), []);
  assert.deepEqual(tokenize(''), []);
});

test('commandPalette：匹配档位 前缀 > 词首 > 子串', () => {
  assert.equal(scoreText('Fix login bug', 'fix'), MATCH_PREFIX);
  assert.equal(scoreText('Fix login bug', 'login'), MATCH_WORD_START);
  assert.equal(scoreText('Fix login bug', 'ogin'), MATCH_SUBSTRING);
  assert.equal(scoreText('Fix login bug', 'zzz'), 0);
  assert.equal(scoreText('Codex', 'code'), MATCH_PREFIX, '大小写不敏感');
  assert.equal(scoreText('/work/sessionport', 'sessionport'), MATCH_WORD_START, '/ 是词分隔符');
  assert.ok(MATCH_PREFIX > MATCH_WORD_START && MATCH_WORD_START > MATCH_SUBSTRING);
});

test('commandPalette：同一字段多次出现时取最好的一档', () => {
  // 'code' 第一次出现在 decode 中间（子串），第二次是词首
  assert.equal(scoreText('decode code', 'code'), MATCH_WORD_START);
});

test('commandPalette：scoreCommand 多 token 是 AND，且必须有命中', () => {
  const cmd = command({ id: 'c1', label: 'Fix login bug' });
  assert.ok((scoreCommand(cmd, 'fix bug') ?? 0) > 0);
  assert.equal(scoreCommand(cmd, 'fix deploy'), null);
  assert.equal(scoreCommand(cmd, ''), 0, '空查询不打分但保留');
  assert.equal(scoreCommand(cmd, '   '), 0);
});

test('commandPalette：页面命令 = 会话 / 适配器 / 迁移 / 设置', () => {
  const pages = buildPageCommands(fakeT);
  assert.deepEqual(pages.map((page) => page.view), ['sessions', 'agents', 'migrate', 'settings']);
  assert.ok(pages.every((page) => page.group === 'pages'));
  assert.deepEqual(pages.map((page) => page.label), ['nav.sessions', 'nav.agents', 'nav.migrate', 'app.settings']);
  assert.deepEqual(pages.map((page) => page.id), ['page:sessions', 'page:agents', 'page:migrate', 'page:settings']);
});

test('commandPalette：操作命令 = 刷新 / 切换主题 / 打开设置', () => {
  const actions = buildActionCommands(fakeT, 'dark');
  assert.deepEqual(actions.map((action) => action.action), ['refresh-sessions', 'cycle-theme', 'open-settings']);
  assert.ok(actions.every((action) => action.group === 'actions'));
  // 深色 → 下一个是跟随系统
  assert.equal(actions[1]?.hint, 'palette.action.cycleThemeHint(current=theme.dark,next=theme.system)');
});

test('commandPalette：主题循环 system → light → dark → system', () => {
  assert.equal(nextTheme('system'), 'light');
  assert.equal(nextTheme('light'), 'dark');
  assert.equal(nextTheme('dark'), 'system');
  assert.equal(themeMessageKey('system'), 'theme.system');
  assert.equal(themeMessageKey('light'), 'theme.light');
  assert.equal(themeMessageKey('dark'), 'theme.dark');
});

test('commandPalette：会话命令按 updatedAt 倒序、标题缺省用 sessionId', () => {
  const commands = buildSessionCommands(SESSIONS, { agentLabel: (agent) => 'label:' + agent });
  assert.deepEqual(commands.map((entry) => entry.id), [
    'session:codex:rollout-001:/work/sessionport/.codex/rollout-001.jsonl',
    'session:claude-code:abc-123:/home/.claude/projects/notes/abc-123.jsonl',
    'session:kimi-code:kimi-9:/home/.kimi/sessions/kimi-9.json',
  ]);
  assert.equal(commands[0]?.label, 'Fix login bug');
  assert.equal(commands[2]?.label, 'kimi-9', '没有标题时回退到 sessionId');
  assert.equal(commands[0]?.hint, '/work/sessionport');
  assert.deepEqual(commands[0]?.keywords?.slice(-2), ['label:codex', 'codex']);
  assert.equal(commands[0]?.session, SESSIONS[0], '会话命令带原始行，供 onOpenSession 使用');
});

test('commandPalette：rankCommands 前缀 > 词首 > 子串，不匹配的丢弃', () => {
  const commands = [
    command({ id: 'substring', label: 'xxcode yy' }),
    command({ id: 'word-start', label: 'xx code' }),
    command({ id: 'prefix', label: 'code thing' }),
    command({ id: 'none', label: 'unrelated' }),
  ];
  assert.deepEqual(
    rankCommands(commands, 'code').map((entry) => entry.id),
    ['prefix', 'word-start', 'substring'],
  );
});

test('commandPalette：标签命中优先于路径命中（字段权重）', () => {
  const commands = [
    command({ id: 'hint', label: 'zzz', hint: '/work/xcode' }),
    command({ id: 'label', label: 'a code b' }),
  ];
  assert.deepEqual(
    rankCommands(commands, 'code').map((entry) => entry.id),
    ['label', 'hint'],
  );
});

test('commandPalette：空查询保持原顺序（会话按时间、页面/操作按定义顺序）', () => {
  const all = buildCommands({ sessions: SESSIONS, t: fakeT, theme: 'system', agentLabel: (agent) => agent });
  assert.deepEqual(
    rankCommands(all, '').map((entry) => entry.id),
    all.map((entry) => entry.id),
  );
  assert.deepEqual(all.map((entry) => entry.group).slice(0, 3), ['sessions', 'sessions', 'sessions']);
  assert.equal(all.length, SESSIONS.length + 4 + 3);
});

test('commandPalette：可模糊搜索 sessionId / 路径 / agent', () => {
  const all = buildCommands({ sessions: SESSIONS, t: fakeT, theme: 'system', agentLabel: (agent) => agent });
  assert.deepEqual(rankCommands(all, 'kimi-9').map((entry) => entry.id), [
    'session:kimi-code:kimi-9:/home/.kimi/sessions/kimi-9.json',
  ]);
  assert.deepEqual(rankCommands(all, 'claude-code').map((entry) => entry.id), [
    'session:claude-code:abc-123:/home/.claude/projects/notes/abc-123.jsonl',
  ]);
  assert.ok(rankCommands(all, '/work/notes').some((entry) => entry.id.includes('abc-123')));
});

test('commandPalette：visibleCommands 有空查询会话上限与查询上限', () => {
  const many: PaletteSession[] = Array.from({ length: 8 }, (_unused, index) => ({
    agent: 'codex',
    sessionId: 's-' + index,
    title: 'port session ' + index,
    nativePath: '/tmp/s-' + index + '.jsonl',
    updatedAt: '2026-03-0' + String(index + 1) + 'T00:00:00.000Z',
  }));
  const all = buildCommands({ sessions: many, t: fakeT, theme: 'system' });
  const emptyQuery = visibleCommands(all, '');
  assert.equal(emptyQuery.filter((entry) => entry.group === 'sessions').length, 6, '默认只显示 6 条最近会话');
  assert.equal(emptyQuery.filter((entry) => entry.group === 'pages').length, 4, '页面命令不截断');
  assert.equal(emptyQuery.filter((entry) => entry.group === 'actions').length, 3);
  assert.equal(visibleCommands(all, '', { maxSessionsWhenEmpty: 2 }).filter((entry) => entry.group === 'sessions').length, 2);
  assert.equal(visibleCommands(all, 'port', { maxSessions: 3 }).filter((entry) => entry.group === 'sessions').length, 3);
});

test('commandPalette：visibleCommands 顺序 = 分组展示顺序（键盘下标与渲染一致）', () => {
  const commands = [
    command({ id: 'session', group: 'sessions', label: 'x settings x' }),
    command({ id: 'page', group: 'pages', label: 'settings page' }),
    command({ id: 'action', group: 'actions', label: 'settings action' }),
  ];
  // 纯打分：页面 / 操作（前缀）> 会话（词首）
  assert.deepEqual(rankCommands(commands, 'settings').map((entry) => entry.id), ['page', 'action', 'session']);
  // 渲染顺序：会话 → 页面 → 操作，组内仍按分数
  assert.deepEqual(visibleCommands(commands, 'settings').map((entry) => entry.id), ['session', 'page', 'action']);
});

test('commandPalette：groupCommands 固定分组顺序且丢掉空分组', () => {
  const commands = [
    command({ id: 'a', label: 'action', group: 'actions' }),
    command({ id: 'p', label: 'page', group: 'pages' }),
    command({ id: 's', label: 'session', group: 'sessions' }),
  ];
  assert.deepEqual(groupCommands(commands).map((section) => section.group), ['sessions', 'pages', 'actions']);
  const onlySessions = [command({ id: 's', label: 'session' })];
  assert.deepEqual(groupCommands(onlySessions).map((section) => section.group), ['sessions']);
  assert.deepEqual(groupCommands([]), []);
});

test('commandPalette：选中项循环移动与夹取', () => {
  assert.equal(stepSelection(0, 1, 3), 1);
  assert.equal(stepSelection(2, 1, 3), 0);
  assert.equal(stepSelection(0, -1, 3), 2);
  assert.equal(stepSelection(1, 0, 3), 1);
  assert.equal(stepSelection(0, 1, 0), 0);
  assert.equal(clampSelection(5, 3), 2);
  assert.equal(clampSelection(-1, 3), 0);
  assert.equal(clampSelection(1, 0), -1);
});

test('commandPalette：resolveCommand 覆盖三组命令且没有空命令', () => {
  const all = buildCommands({ sessions: SESSIONS, t: fakeT, theme: 'system', agentLabel: (agent) => agent });
  assert.ok(all.every((entry) => resolveCommand(entry) !== null), '每条命令都必须可执行');

  const session = resolveCommand(all[0]!);
  assert.equal(session?.kind, 'open-session');
  assert.equal(session?.kind === 'open-session' ? session.session.sessionId : '', 'rollout-001');

  const page = all.find((entry) => entry.id === 'page:migrate');
  assert.deepEqual(resolveCommand(page!), { kind: 'navigate', view: 'migrate' });

  const action = all.find((entry) => entry.id === 'action:refresh-sessions');
  assert.deepEqual(resolveCommand(action!), { kind: 'action', action: 'refresh-sessions' });

  assert.equal(resolveCommand(command({ id: 'orphan', label: 'orphan' })), null);
});

test('commandPalette：buildCommands 组合三组命令', () => {
  const all = buildCommands({
    sessions: SESSIONS,
    t: fakeT,
    theme: 'light',
    agentLabel: (agent) => 'label:' + agent,
  });
  assert.deepEqual(all.map((entry) => entry.group), [
    'sessions',
    'sessions',
    'sessions',
    'pages',
    'pages',
    'pages',
    'pages',
    'actions',
    'actions',
    'actions',
  ]);
  const ids = new Set(all.map((entry) => entry.id));
  assert.equal(ids.size, all.length, '命令 id 必须唯一');
});
