import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * 把一份 transcript 注册进 Command Code 桌面端列表。
 *
 * 为什么需要这一步：桌面端列表由 thread-index.db（渲染层直接读）和
 * app-state.json 的 appState.threads/projects（启动时 reconcile 进索引）共同决定，
 * 而 seedThreadIndex 只在索引为空时才从磁盘重建 —— 只写 transcript 不会出现在列表里。
 */
export interface RegisterThreadSpec {
  id: string;
  title: string;
  projectPath: string;
  model?: string;
  /** epoch ms */
  createdAt?: number;
  /** epoch ms */
  lastActivityAt?: number;
}

export interface RegisterResult {
  installed: boolean;
  appStatePath?: string;
  dbPath?: string;
  /** 未安装时的原因 */
  reason?: string;
  backupPaths?: string[];
}

export interface RegisterOptions {
  /** 桌面端数据目录，默认 ~/Library/Application Support/Command Code */
  userDataDir?: string;
  /** 备份目录，默认 .tmp/cc-backups */
  backupDir?: string;
}

export function commandCodeUserDataDir(explicit?: string): string {
  if (explicit) return resolve(explicit);
  if (process.env.CC_USER_DATA_DIR) return resolve(process.env.CC_USER_DATA_DIR);
  return join(homedir(), 'Library', 'Application Support', 'Command Code');
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function registerCommandCodeThread(spec: RegisterThreadSpec, options: RegisterOptions = {}): RegisterResult {
  const userDataDir = commandCodeUserDataDir(options.userDataDir);
  const appStatePath = join(userDataDir, 'app-state.json');
  const dbPath = join(userDataDir, 'thread-index.db');
  if (!existsSync(appStatePath) || !existsSync(dbPath)) {
    return { installed: false, reason: '找不到 Command Code 桌面端数据目录（先启动过一次 app）: ' + userDataDir };
  }

  const now = Date.now();
  const createdAt = spec.createdAt ?? now;
  const lastActivityAt = spec.lastActivityAt ?? now;
  const backupPaths: string[] = [];
  const backupDir = options.backupDir ?? join(process.cwd(), '.tmp', 'cc-backups');
  try {
    mkdirSync(backupDir, { recursive: true });
    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
    for (const [src, name] of [[appStatePath, 'app-state-' + stamp + '.json'], [dbPath, 'thread-index-' + stamp + '.db']] as const) {
      const dest = join(backupDir, name);
      copyFileSync(src, dest);
      backupPaths.push(dest);
    }
  } catch {
    // 备份失败不阻塞注册
  }

  const doc = readJson(appStatePath);
  if (doc) {
    const state = (doc.appState ?? (doc.appState = {})) as Record<string, unknown>;
    const threads = Array.isArray(state.threads) ? (state.threads as Array<Record<string, unknown>>) : [];
    const thread: Record<string, unknown> = {
      id: spec.id,
      title: spec.title,
      titleSource: 'generated',
      messages: [],
      createdAt,
      updatedAt: lastActivityAt,
      projectPath: spec.projectPath,
      model: spec.model ?? '',
      permissionMode: 'default',
      lastActivityAt,
      hasTranscript: true,
      unread: false,
    };
    const at = threads.findIndex((t) => t && t.id === spec.id);
    if (at >= 0) threads[at] = thread;
    else threads.push(thread);
    state.threads = threads;

    const projects = Array.isArray(state.projects) ? (state.projects as Array<Record<string, unknown>>) : [];
    if (!projects.some((p) => p && p.path === spec.projectPath)) projects.push({ path: spec.projectPath, registeredAt: now });
    state.projects = projects;

    for (const key of ['hiddenSessions', 'deletedThreads'] as const) {
      const map = state[key];
      if (map && typeof map === 'object') delete (map as Record<string, unknown>)[spec.id];
    }
    const removed = state.removedProjects;
    if (removed && typeof removed === 'object') delete (removed as Record<string, unknown>)[spec.projectPath];

    writeFileSync(appStatePath, JSON.stringify(doc, null, 2));
  }

  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.prepare(
      'INSERT INTO threads (id,title,project_path,model,git_branch,unread,created_at,updated_at,last_activity_at,has_transcript) ' +
        'VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET ' +
        'title=excluded.title, project_path=excluded.project_path, model=excluded.model, git_branch=excluded.git_branch, ' +
        'unread=excluded.unread, updated_at=excluded.updated_at, last_activity_at=excluded.last_activity_at, has_transcript=excluded.has_transcript',
    ).run(spec.id, spec.title, spec.projectPath, spec.model ?? '', '', 0, createdAt, lastActivityAt, lastActivityAt, 1);
  } finally {
    db.close();
  }

  return { installed: true, appStatePath, dbPath, backupPaths };
}
