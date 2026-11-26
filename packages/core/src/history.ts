import { randomBytes } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import type { AdapterWriteOutcome } from './adapter.ts';
import type { AgentId } from './ir.ts';
import { registryPath, sessionportHome } from './registry.ts';

export type HistoryAction = 'push' | 'sync' | 'merge-back' | 'desktop-migrate';

export interface FileSnapshot {
  path: string;
  existed: boolean;
  /** 相对 <opDir>/files/ 的文件名 */
  backupFile?: string;
  bytes?: number;
}

export interface RegistrySnapshot {
  existed: boolean;
  backupFile?: string;
}

export interface CursorUndoInfo {
  dbPath: string;
  composerId: string;
  backupPath?: string;
}

export interface HistoryRecord {
  version: 1;
  id: string;
  createdAt: string;
  action: HistoryAction;
  sourceKey: string;
  target: AgentId;
  targetId: string;
  targetHome?: string;
  files: FileSnapshot[];
  registry?: RegistrySnapshot;
  cursor?: CursorUndoInfo;
  caveats: string[];
  undoneAt?: string;
}

export interface UndoPlan {
  opId: string;
  filesToRestore: string[];
  filesToDelete: string[];
  restoreRegistry: boolean;
  deleteRegistry: boolean;
  cursorBackupPath?: string;
  caveats: string[];
}

export interface UndoResult {
  opId: string;
  dryRun: boolean;
  restoredFiles: string[];
  deletedFiles: string[];
  missingFiles: string[];
  registryRestored: boolean;
  registryDeleted: boolean;
  cursorRestored: boolean;
  caveats: string[];
}

export interface BeginBackupOptions {
  stateHome?: string;
  action: HistoryAction;
  sourceKey: string;
  target: AgentId;
  targetId: string;
  targetHome?: string;
  plannedPaths: string[];
  includeRegistry?: boolean;
  caveats?: string[];
}

export interface FinalizeBackupExtra {
  targetId?: string;
  actualPaths?: string[];
  cursor?: CursorUndoInfo;
  caveats?: string[];
}

export interface BackupHandle {
  id: string;
  dir: string;
  cursorBackupDir: string;
  record: HistoryRecord;
  finalize(extra?: FinalizeBackupExtra): HistoryRecord;
  abort(): void;
}

let lastStampMs = 0;

function nextMonotonicDate(): Date {
  const now = Date.now();
  lastStampMs = now > lastStampMs ? now : lastStampMs + 1;
  return new Date(lastStampMs);
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = filePath + '.tmp-' + process.pid + '-' + randomBytes(4).toString('hex');
  writeFileSync(tmpPath, JSON.stringify(value, null, 2) + '\n', 'utf8');
  renameSync(tmpPath, filePath);
}

function copyFileAtomic(sourcePath: string, destPath: string): void {
  mkdirSync(dirname(destPath), { recursive: true });
  const tmpPath = destPath + '.tmp-' + process.pid + '-' + randomBytes(4).toString('hex');
  copyFileSync(sourcePath, tmpPath);
  renameSync(tmpPath, destPath);
}

function isSafeOpId(opId: string): boolean {
  return /^[A-Za-z0-9._-]+$/u.test(opId) && !opId.includes('..');
}

function dedupeStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

export function historyRootDir(stateHome?: string): string {
  return join(sessionportHome(stateHome), 'history');
}

export function createOperationId(now: Date = new Date()): string {
  const pad2 = (n: number): string => String(n).padStart(2, '0');
  const stamp =
    String(now.getUTCFullYear()) +
    pad2(now.getUTCMonth() + 1) +
    pad2(now.getUTCDate()) +
    'T' +
    pad2(now.getUTCHours()) +
    pad2(now.getUTCMinutes()) +
    pad2(now.getUTCSeconds()) +
    'Z';
  return stamp + '-' + randomBytes(4).toString('hex');
}

/** 收集一次写出的全部目标路径（主文件 + 子代理文件与 meta 文件） */
export function collectOutcomePaths(outcome: AdapterWriteOutcome): string[] {
  const raw: string[] = [...outcome.paths];
  const children = outcome.report.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      if (!child || typeof child !== 'object') continue;
      const entry = child as { filePath?: unknown; metaPath?: unknown };
      if (typeof entry.filePath === 'string' && entry.filePath.length > 0) raw.push(entry.filePath);
      if (typeof entry.metaPath === 'string' && entry.metaPath.length > 0) raw.push(entry.metaPath);
    }
  }
  const resolved: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string' || item.length === 0) continue;
    const abs = resolve(item);
    if (seen.has(abs)) continue;
    seen.add(abs);
    resolved.push(abs);
  }
  return resolved;
}

export function beginBackup(opts: BeginBackupOptions): BackupHandle {
  const now = nextMonotonicDate();
  const root = historyRootDir(opts.stateHome);
  let id = createOperationId(now);
  let dir = join(root, id);
  while (existsSync(dir)) {
    id = createOperationId(now);
    dir = join(root, id);
  }
  const filesDir = join(dir, 'files');
  const cursorBackupDir = join(dir, 'cursor-backup');
  mkdirSync(filesDir, { recursive: true });

  const resolvedPlanned: string[] = [];
  const seenPaths = new Set<string>();
  for (const p of opts.plannedPaths) {
    if (typeof p !== 'string' || p.length === 0) continue;
    const abs = resolve(p);
    if (seenPaths.has(abs)) continue;
    seenPaths.add(abs);
    resolvedPlanned.push(abs);
  }

  const files: FileSnapshot[] = [];
  resolvedPlanned.forEach((absPath, idx) => {
    if (existsSync(absPath)) {
      const stat = statSync(absPath);
      if (stat.isFile()) {
        const backupFile = String(idx) + '.bak';
        copyFileSync(absPath, join(filesDir, backupFile));
        files.push({ path: absPath, existed: true, backupFile, bytes: stat.size });
        return;
      }
    }
    files.push({ path: absPath, existed: false });
  });

  let registry: RegistrySnapshot | undefined;
  if (opts.includeRegistry === true) {
    const regFile = registryPath(opts.stateHome);
    if (existsSync(regFile) && statSync(regFile).isFile()) {
      copyFileSync(regFile, join(filesDir, 'registry.json.bak'));
      registry = { existed: true, backupFile: 'registry.json.bak' };
    } else {
      registry = { existed: false };
    }
  }

  const record: HistoryRecord = {
    version: 1,
    id,
    createdAt: now.toISOString(),
    action: opts.action,
    sourceKey: opts.sourceKey,
    target: opts.target,
    targetId: opts.targetId,
    ...(opts.targetHome !== undefined ? { targetHome: opts.targetHome } : {}),
    files,
    ...(registry !== undefined ? { registry } : {}),
    caveats: dedupeStrings(opts.caveats ?? []),
  };

  let closed = false;
  return {
    id,
    dir,
    cursorBackupDir,
    record,
    finalize(extra: FinalizeBackupExtra = {}): HistoryRecord {
      if (closed) return record;
      closed = true;
      if (extra.targetId !== undefined) record.targetId = extra.targetId;
      if (Array.isArray(extra.actualPaths)) {
        const tracked = new Set(record.files.map((item) => item.path));
        for (const p of extra.actualPaths) {
          if (typeof p !== 'string' || p.length === 0) continue;
          const abs = resolve(p);
          if (tracked.has(abs)) continue;
          tracked.add(abs);
          record.files.push({ path: abs, existed: false });
        }
      }
      if (extra.cursor !== undefined) record.cursor = extra.cursor;
      if (Array.isArray(extra.caveats) && extra.caveats.length > 0) {
        record.caveats = dedupeStrings([...record.caveats, ...extra.caveats]);
      }
      writeJsonAtomic(join(dir, 'manifest.json'), record);
      pruneHistory(opts.stateHome, 50);
      return record;
    },
    abort(): void {
      if (closed) return;
      closed = true;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function readManifestFromDir(dir: string): HistoryRecord | undefined {
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as Partial<HistoryRecord>;
    if (parsed.version !== 1 || typeof parsed.id !== 'string' || !Array.isArray(parsed.files)) return undefined;
    return parsed as HistoryRecord;
  } catch {
    return undefined;
  }
}

export function listHistory(stateHome?: string, limit = 50): HistoryRecord[] {
  const root = historyRootDir(stateHome);
  if (!existsSync(root)) return [];
  const entries = readdirSync(root, { withFileTypes: true });
  const records: HistoryRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const record = readManifestFromDir(join(root, entry.name));
    if (record) records.push(record);
  }
  records.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  return limit > 0 ? records.slice(0, limit) : records;
}

export function pruneHistory(stateHome?: string, keep = 50): number {
  const safeKeep = Math.max(0, keep);
  const all = listHistory(stateHome, 0);
  if (all.length <= safeKeep) return 0;
  const root = historyRootDir(stateHome);
  let removed = 0;
  for (const record of all.slice(safeKeep)) {
    if (!isSafeOpId(record.id)) continue;
    rmSync(join(root, record.id), { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

export function loadHistoryRecord(opId: string, stateHome?: string): HistoryRecord | undefined {
  if (!isSafeOpId(opId)) return undefined;
  return readManifestFromDir(join(historyRootDir(stateHome), opId));
}

export function latestUndoableRecord(stateHome?: string): HistoryRecord | undefined {
  return listHistory(stateHome, 0).find((record) => record.undoneAt === undefined);
}

export function planUndo(record: HistoryRecord): UndoPlan {
  const filesToRestore: string[] = [];
  const filesToDelete: string[] = [];
  for (const file of record.files) {
    if (file.existed) filesToRestore.push(file.path);
    else filesToDelete.push(file.path);
  }
  return {
    opId: record.id,
    filesToRestore,
    filesToDelete,
    restoreRegistry: record.registry?.existed === true,
    deleteRegistry: record.registry?.existed === false,
    ...(record.cursor?.backupPath !== undefined ? { cursorBackupPath: record.cursor.backupPath } : {}),
    caveats: [...record.caveats],
  };
}

export async function applyUndo(
  record: HistoryRecord,
  opts: {
    stateHome?: string;
    dryRun?: boolean;
    restoreCursor?: (backupPath: string) => Promise<void> | void;
  } = {},
): Promise<UndoResult> {
  if (record.undoneAt !== undefined) {
    throw new Error('操作 ' + record.id + ' 已经撤销过（' + record.undoneAt + '）');
  }

  const plan = planUndo(record);
  const caveats = [...plan.caveats];
  if (opts.dryRun === true) {
    return {
      opId: record.id,
      dryRun: true,
      restoredFiles: plan.filesToRestore,
      deletedFiles: plan.filesToDelete,
      missingFiles: [],
      registryRestored: plan.restoreRegistry,
      registryDeleted: plan.deleteRegistry,
      cursorRestored: false,
      caveats,
    };
  }

  const opDir = join(historyRootDir(opts.stateHome), record.id);
  const filesDir = join(opDir, 'files');

  // 恢复前先校验所有备份源都存在，避免半途失败
  for (const file of record.files) {
    if (!file.existed) continue;
    const backupFile = file.backupFile ? join(filesDir, file.backupFile) : undefined;
    if (!backupFile || !existsSync(backupFile)) {
      throw new Error('缺少备份文件，无法恢复 ' + file.path + ': ' + (backupFile ?? '(empty)'));
    }
  }
  if (record.registry?.existed === true) {
    const regBackup = record.registry.backupFile ? join(filesDir, record.registry.backupFile) : undefined;
    if (!regBackup || !existsSync(regBackup)) {
      throw new Error('缺少 registry 备份文件: ' + (regBackup ?? '(empty)'));
    }
  }

  const restoredFiles: string[] = [];
  const deletedFiles: string[] = [];
  const missingFiles: string[] = [];

  for (const file of record.files) {
    if (file.existed) {
      const backupFile = join(filesDir, file.backupFile!);
      copyFileAtomic(backupFile, file.path);
      restoredFiles.push(file.path);
    } else if (existsSync(file.path)) {
      unlinkSync(file.path);
      deletedFiles.push(file.path);
      try {
        rmdirSync(dirname(file.path));
      } catch {
        // 目录非空或无权限时保留，绝不递归删除
      }
    } else {
      missingFiles.push(file.path);
    }
  }

  let registryRestored = false;
  let registryDeleted = false;
  if (record.registry !== undefined) {
    const regFile = registryPath(opts.stateHome);
    if (record.registry.existed) {
      copyFileAtomic(join(filesDir, record.registry.backupFile!), regFile);
      registryRestored = true;
    } else if (existsSync(regFile)) {
      unlinkSync(regFile);
      registryDeleted = true;
    }
  }

  let cursorRestored = false;
  if (record.cursor?.backupPath !== undefined) {
    if (opts.restoreCursor) {
      await opts.restoreCursor(record.cursor.backupPath);
      cursorRestored = true;
    } else {
      caveats.push('未提供 Cursor 回滚回调，仅记录 backupPath: ' + record.cursor.backupPath);
    }
  }

  const updated: HistoryRecord = {
    ...record,
    caveats,
    undoneAt: new Date().toISOString(),
  };
  writeJsonAtomic(join(opDir, 'manifest.json'), updated);

  return {
    opId: record.id,
    dryRun: false,
    restoredFiles,
    deletedFiles,
    missingFiles,
    registryRestored,
    registryDeleted,
    cursorRestored,
    caveats,
  };
}
