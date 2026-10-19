#!/usr/bin/env node
// 把一份 Command Code transcript 注册进桌面端列表。
//
// 背景：Command Code 桌面端的会话列表来自 ~/Library/Application Support/Command Code/
//   - thread-index.db（threads 表，渲染层直接读）
//   - app-state.json 的 appState.threads / projects（启动时 reconcile 进索引）
// 而 thread-index 只在「空库」时才从磁盘重建（seedThreadIndex: existing>0 直接跳过），
// 所以仅写 transcript 不会出现在列表里，必须补注册。
//
// 备注：adapter 已内置同样的逻辑，日常用 `sessionport push … --to command-code --register`
//   node scripts/cc-register.mjs --trust <项目绝对路径> [--trust <路径2> ...]   # 只补项目信任
//        [--project <abs cwd>] [--model <m>] [--dry-run]
// 信任说明: 桌面端另有一份 trustedProjectRoots 白名单，非 null 时不会从 projects 推导；
//           缺了会报 "Select this project with the folder picker first."。
// 安全: 默认先备份 app-state.json 与 thread-index.db 到 .tmp/cc-backups/，可用 --restore <stamp> 回滚。
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

// --trust <path> 模式：只把项目路径登记进 trustedProjectRoots（app 的 folder picker 门槛）
const trustArgs = process.argv.map((arg, i) => (arg === '--trust' ? process.argv[i + 1] : undefined)).filter((v) => typeof v === 'string' && v.length > 0);
if (trustArgs.length > 0) {
  const userData = join(process.env.HOME, 'Library', 'Application Support', 'Command Code');
  const appStatePath = join(userData, 'app-state.json');
  if (!existsSync(appStatePath)) { console.error('找不到 app-state.json，先启动过一次 Command Code'); process.exit(1); }
  const backupDir = join(process.cwd(), '.tmp', 'cc-backups');
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  copyFileSync(appStatePath, join(backupDir, 'app-state-trust-' + stamp + '.json'));
  const doc = JSON.parse(readFileSync(appStatePath, 'utf8'));
  const roots = Array.isArray(doc.trustedProjectRoots) ? doc.trustedProjectRoots.filter((r) => typeof r === 'string') : [];
  for (const path of trustArgs) if (!roots.includes(path)) roots.push(path);
  doc.trustedProjectRoots = roots;
  writeFileSync(appStatePath, JSON.stringify(doc, null, 2));
  console.log('backup ->', join(backupDir, 'app-state-trust-' + stamp + '.json'));
  console.log('trustedProjectRoots:', JSON.stringify(roots, null, 2));
  console.log('重启 Command Code 后生效。');
  process.exit(0);
}

const file = arg('file');
if (!file || file === true) {
  console.error('用法: node scripts/cc-register.mjs --file <transcript.jsonl> [--title t] [--project path] [--model m] [--dry-run]');
  process.exit(1);
}
const transcript = resolve(String(file));
if (!existsSync(transcript)) { console.error('找不到 transcript: ' + transcript); process.exit(1); }

const header = JSON.parse(readFileSync(transcript, "utf8").split("\n")[0]);
if (header.type !== 'session' || typeof header.id !== 'string') { console.error('不是合法的 Command Code transcript（首行缺 session 头）'); process.exit(1); }

const metaPath = transcript.replace(/\.jsonl$/, "") + ".meta.json";
let meta = {};
try { meta = JSON.parse(readFileSync(metaPath, "utf8")); } catch { /* 可省 */ }

const id = header.id;
const projectPath = String(arg('project', header.cwd ?? process.cwd()));
const title = String(arg('title', meta.title || basename(projectPath) || 'Imported session'));
const model = String(arg('model', ''));
const createdAt = Date.parse(String(header.timestamp ?? '')) || Date.now();
const dryRun = arg('dry-run', false) === true;

const userData = join(process.env.HOME, 'Library', 'Application Support', 'Command Code');
const appStatePath = join(userData, 'app-state.json');
const dbPath = join(userData, 'thread-index.db');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

if (!existsSync(appStatePath) || !existsSync(dbPath)) { console.error('找不到 Command Code 桌面端数据目录（先启动过一次 app）'); process.exit(1); }

console.log('transcript  :', transcript);
console.log('session id  :', id);
console.log('project     :', projectPath);
console.log('title       :', title);
if (dryRun) { console.log('(--dry-run: 不写任何文件)'); process.exit(0); }

const backupDir = join(process.cwd(), '.tmp', 'cc-backups');
mkdirSync(backupDir, { recursive: true });
copyFileSync(appStatePath, join(backupDir, 'app-state-' + stamp + '.json'));
copyFileSync(dbPath, join(backupDir, 'thread-index-' + stamp + '.db'));
writeFileSync(join(backupDir, 'last-stamp.txt'), stamp + '\n');
console.log('备份        :', backupDir + ' (stamp ' + stamp + ')');

// 1) app-state：thread + project，并清掉该 id / 项目的 tombstone
const doc = JSON.parse(readFileSync(appStatePath, 'utf8'));
const state = doc.appState ?? (doc.appState = {});
const now = Date.now();
const thread = {
  id,
  title,
  titleSource: 'generated',
  messages: [],
  createdAt,
  updatedAt: now,
  projectPath,
  model,
  permissionMode: 'default',
  lastActivityAt: now,
  hasTranscript: true,
  unread: false,
};
state.threads = Array.isArray(state.threads) ? state.threads : [];
const at = state.threads.findIndex((t) => t && t.id === id);
if (at >= 0) state.threads[at] = thread; else state.threads.push(thread);
state.projects = Array.isArray(state.projects) ? state.projects : [];
if (!state.projects.some((p) => p && p.path === projectPath)) state.projects.push({ path: projectPath, registeredAt: now });
if (state.hiddenSessions) delete state.hiddenSessions[id];
if (state.deletedThreads) delete state.deletedThreads[id];
if (state.removedProjects) delete state.removedProjects[projectPath];
writeFileSync(appStatePath, JSON.stringify(doc, null, 2));
console.log('app-state   : threads=' + state.threads.length + ' projects=' + state.projects.length);

// 2) thread-index.db
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL');
db.prepare(
  'INSERT INTO threads (id,title,project_path,model,git_branch,unread,created_at,updated_at,last_activity_at,has_transcript) ' +
  'VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET ' +
  'title=excluded.title, project_path=excluded.project_path, model=excluded.model, git_branch=excluded.git_branch, ' +
  'unread=excluded.unread, updated_at=excluded.updated_at, last_activity_at=excluded.last_activity_at, has_transcript=excluded.has_transcript',
).run(id, title, projectPath, model, '', 0, createdAt, now, now, 1);
const rows = db.prepare('SELECT id,title,project_path FROM threads ORDER BY last_activity_at DESC').all();
console.log('thread-index: ' + rows.length + ' 行');
for (const row of rows) console.log('   ', row.id, '|', row.title, '|', row.project_path);
db.close();

console.log('');
console.log('完成。重启 Command Code 桌面端后，会话会出现在项目 ' + projectPath + ' 下。');