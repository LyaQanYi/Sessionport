/**
 * 复用目标 app 的「官方导入」能力。
 *
 * 背景：ZCode 与 Qoder 都内置了官方的会话迁移/数据导入功能（GUI 设置里），
 * 它们直接从源 app 的原生存储读取，比我们逆向私有格式更完整（还能带记忆/MCP/技能），
 * 但都没有可脚本触发的 CLI/IPC。所以这里做「准备 + 引导 + 事后验证」：
 *   1. 把源会话准备成官方导入器会扫描的形态（ZCode 读 ~/.claude/projects；Qoder 读 ~/.workbuddy）
 *   2. 给出目标 app 里的精确操作路径（--open 可直接打开 app）
 *   3. --verify 读取目标 app 自己的索引/存储，确认导入结果
 *
 * Cursor 目前没有官方导入（社区 feature request），只能走 sessionport 的直接写入。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import type { IrBundle } from '@sessionport/core';

export type OfficialTarget = 'zcode' | 'qoder' | 'cursor';

export interface OfficialSupport {
  target: OfficialTarget;
  appName: string;
  supported: boolean;
  mechanism: 'gui-settings' | 'gui-onboarding' | 'none';
  /** 官方导入器会读取的源 */
  sources: Array<'claude-code' | 'workbuddy' | 'qoder' | 'other'>;
  /** 目标 app 自己的存储/索引（验证用） */
  store: string;
  notes: string[];
}

export const OFFICIAL_IMPORTS: OfficialSupport[] = [
  {
    target: 'zcode',
    appName: 'ZCode',
    supported: true,
    mechanism: 'gui-onboarding',
    sources: ['claude-code'],
    store: '~/.zcode/v2/tasks-index.sqlite',
    notes: [
      'ZCode 内置 ClaudeNativeSessionImportRepo，扫描 ~/.claude/projects（以及 CLAUDE_CONFIG_DIR/HOME）',
      '入口：首次引导「迁移会话数据」或 设置 → 迁移会话数据（从 Claude Code 迁移历史会话数据）',
      '导入的任务写入 tasks-index.sqlite 的 tasks 表（带 migration_source 标记）',
    ],
  },
  {
    target: 'qoder',
    appName: 'Qoder CN',
    supported: true,
    mechanism: 'gui-settings',
    sources: ['workbuddy'],
    store: '~/.qoder-cn/projects/<projectKey>/<uuid>.jsonl',
    notes: [
      'Qoder「设置 → 数据导入」原生支持从 WorkBuddy（以及其它来源）导入会话、MCP、记忆',
      '主进程按 ~/.workbuddy、~/.codebuddy 等路径检测来源；导入后写进 ~/.qoder-cn/projects',
      '没有 CLI/深链触发入口，只能在设置里点「开始导入」',
    ],
  },
  {
    target: 'cursor',
    appName: 'Cursor',
    supported: false,
    mechanism: 'none',
    sources: [],
    store: '~/Library/Application Support/Cursor/User/globalStorage/state.vscdb',
    notes: [
      '官方文档没有会话导入；Cursor 3.25.9 有 Developer 命令 Import Chat... / Bulk Import Chats from Directory...，但只吃 Cursor 自己导出的 v1 JSON（protobuf conversationState + blobs）',
      'Claude Code → Cursor 仍是 feature request（官方论坛），所以当前用 sessionport 直接写 state.vscdb：push --to cursor --confirm-real',
      '后续可从 IR 生成 Cursor v1 export JSON，改走 Bulk Import Chats from Directory...（需要一份真实导出做模板）',
    ],
  },
];

export function officialSupport(target: OfficialTarget): OfficialSupport {
  const found = OFFICIAL_IMPORTS.find((entry) => entry.target === target);
  if (!found) throw new Error('未知目标: ' + target + '（可选 zcode / qoder / cursor）');
  return found;
}

export interface OfficialImportOptions {
  target: OfficialTarget;
  bundle: IrBundle;
  /** 目标/中间数据根目录覆盖（测试用） */
  home?: string;
  /** 自动打开目标 app */
  open?: boolean;
}

export interface OfficialImportResult {
  support: OfficialSupport;
  sourceAgent: string;
  sourceTitle?: string;
  sourceCwd?: string;
  prepared: string;
  steps: string[];
  opened: boolean;
  lines: string[];
}

/** 把源会话准备成官方导入器会扫描的形态，并返回操作步骤 */
export async function planOfficialImport(options: OfficialImportOptions): Promise<OfficialImportResult> {
  const support = officialSupport(options.target);
  if (!support.supported) {
    throw new Error(
      support.target + ' 没有官方导入路径；请用 sessionport push --to cursor --confirm-real（直接写入 composer）',
    );
  }
  const session = options.bundle.root;
  const sourceAgent = session.source.agent;
  const lines: string[] = [];
  const home = options.home;

  if (options.target === 'zcode') {
    if (!support.sources.includes(sourceAgent as never)) {
      throw new Error('ZCode 官方导入只扫描 Claude Code 会话；源是 ' + sourceAgent + '，请先 push --to claude-code 再导入');
    }
    const nativePath = session.source.nativePath;
    if (nativePath === undefined || !existsSync(nativePath)) {
      throw new Error('源会话没有可用的 Claude Code transcript 路径');
    }
    lines.push('prepare  ✅ Claude transcript 已就绪：' + nativePath);
    return finish(support, sourceAgent, session.meta.title, session.meta.cwd, nativePath, [
      '打开 ZCode',
      '首次引导里勾选「迁移会话数据」，或进入 设置 → 迁移会话数据',
      '选择「从 Claude Code 迁移历史会话数据」，勾选要导入的会话并开始',
      '回到终端运行：sessionport import --into zcode --source <同一来源> --verify',
    ], options.open, lines);
  }

  // qoder：官方导入直接读 WorkBuddy 数据，我们只需要确认源存在
  if (!support.sources.includes(sourceAgent as never)) {
    throw new Error(
      'Qoder 官方导入的来源是 WorkBuddy（及其它客户端）；源是 ' + sourceAgent + ' 时请先用 sessionport push --to qoder 直接写入',
    );
  }
  const workbuddyHome = home ?? process.env['WORKBUDDY_HOME'] ?? join(homedir(), '.workbuddy');
  const projects = join(workbuddyHome, 'projects');
  if (!existsSync(projects)) {
    throw new Error('没有找到 WorkBuddy 数据目录：' + projects);
  }
  lines.push('prepare  ✅ WorkBuddy 数据已在：' + projects);
  return finish(support, sourceAgent, session.meta.title, session.meta.cwd, projects, [
    '打开 Qoder → 设置 → 数据导入',
    '选择 WorkBuddy → 重新检测',
    '勾选要导入的会话（还可一并导入 MCP / 记忆）→ 开始导入',
    '回到终端运行：sessionport import --into qoder --source <同一来源> --verify',
  ], options.open, lines);
}

function finish(
  support: OfficialSupport,
  sourceAgent: string,
  sourceTitle: string | undefined,
  sourceCwd: string | undefined,
  prepared: string,
  steps: string[],
  open: boolean | undefined,
  lines: string[],
): OfficialImportResult {
  let opened = false;
  if (open === true) {
    const result = spawnSync('open', ['-a', support.appName], { stdio: 'ignore' });
    opened = result.status === 0;
    lines.push((opened ? 'open     ✅ 已打开 ' : 'open     ⚠️ 无法打开 ') + support.appName);
  }
  lines.push('steps    目标 app 里的操作（官方导入，无需 sessionport 写入目标存储）：');
  steps.forEach((step, index) => lines.push('  ' + (index + 1) + '. ' + step));
  lines.push('notes');
  for (const note of support.notes) lines.push('  · ' + note);
  return {
    support,
    sourceAgent,
    sourceTitle,
    sourceCwd,
    prepared,
    steps,
    opened,
    lines,
  };
}

export interface OfficialVerifyResult {
  target: OfficialTarget;
  store: string;
  ok: boolean;
  checked: number;
  matches: Array<{ id: string; title?: string; workspace?: string; at?: string }>;
  lines: string[];
}

/** 读取目标 app 自己的索引/存储，确认导入是否落库 */
export async function verifyOfficialImport(options: {
  target: OfficialTarget;
  cwd?: string;
  title?: string;
  home?: string;
}): Promise<OfficialVerifyResult> {
  const support = officialSupport(options.target);
  if (!support.supported) {
    return {
      target: options.target,
      store: support.store,
      ok: false,
      checked: 0,
      matches: [],
      lines: [support.target + ' 没有官方导入，无需验证；用 sessionport verify --agent cursor 校验直接写入的结果'],
    };
  }
  const home = options.home ?? homedir();
  const lines: string[] = [];
  if (options.target === 'zcode') {
    const dbPath = join(home, '.zcode', 'v2', 'tasks-index.sqlite');
    if (!existsSync(dbPath)) throw new Error('找不到 ZCode 任务索引：' + dbPath);
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db
        .prepare(
          'select task_id, title, workspace_path, migration_source, updated_at from tasks order by updated_at desc limit 20',
        )
        .all() as Array<{ task_id: string; title: string; workspace_path: string; migration_source: string | null; updated_at: number }>;
      const matches = rows
        .filter((row) => {
          const byCwd = options.cwd !== undefined && row.workspace_path === options.cwd;
          const byTitle = options.title !== undefined && row.title === options.title;
          return byCwd || byTitle;
        })
        .map((row) => ({
          id: row.task_id,
          title: row.title,
          workspace: row.workspace_path,
          at: new Date(Number(row.updated_at)).toISOString(),
        }));
      const linesOut = [
        'store    ' + dbPath,
        'tasks    ' + rows.length + ' 条（最近 20）',
        'matches  ' + matches.length + ' 条与来源 cwd/标题一致',
      ];
      for (const match of matches.slice(0, 5)) linesOut.push('  · ' + match.id + '  ' + (match.title ?? ''));
      return { target: 'zcode', store: dbPath, ok: matches.length > 0, checked: rows.length, matches, lines: linesOut };
    } finally {
      db.close();
    }
  }

  // qoder：扫 ~/.qoder-cn/projects 的 jsonl，按 cwd/标题匹配
  const projects = join(home, '.qoder-cn', 'projects');
  if (!existsSync(projects)) throw new Error('找不到 Qoder 数据目录：' + projects);
  const files: Array<{ path: string; mtime: number }> = [];
  for (const project of readdirSync(projects)) {
    const dir = join(projects, project);
    if (!statSync(dir).isDirectory()) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const path = join(dir, name);
      files.push({ path, mtime: statSync(path).mtimeMs });
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const matches: OfficialVerifyResult['matches'] = [];
  for (const file of files.slice(0, 30)) {
    const text = readFileSync(file.path, 'utf8');
    const firstLines = text.split('\n', 3);
    let cwd: string | undefined;
    let title: string | undefined;
    for (const line of firstLines) {
      try {
        const row = JSON.parse(line) as { type?: string; directories?: string[]; customTitle?: string };
        if (row.type === 'workspace-directories' && Array.isArray(row.directories)) cwd = row.directories[0];
        if (row.type === 'custom-title' && typeof row.customTitle === 'string') title = row.customTitle;
      } catch {
        // 坏行忽略
      }
    }
    const byCwd = options.cwd !== undefined && cwd === options.cwd;
    const byTitle = options.title !== undefined && title === options.title;
    if (byCwd || byTitle) {
      matches.push({ id: file.path.split('/').pop()!.replace(/\.jsonl$/, ''), title, workspace: cwd, at: new Date(file.mtime).toISOString() });
    }
  }
  lines.push('store    ' + projects);
  lines.push('files    ' + files.length + ' 份 transcript（最近 30 份里匹配 ' + matches.length + '）');
  for (const match of matches.slice(0, 5)) lines.push('  · ' + match.id + '  ' + (match.title ?? ''));
  return { target: 'qoder', store: projects, ok: matches.length > 0, checked: Math.min(files.length, 30), matches, lines };
}