#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import {
  applyUndo,
  beginBackup,
  buildDeltaAndMergedBundles,
  bundleEventCount,
  collectOutcomePaths,
  describeDecision,
  describeMergeBackDecision,
  eventFingerprint,
  eventKindCounts,
  findRef,
  latestUndoableRecord,
  listAllSessions,
  listHistory,
  loadHistoryRecord,
  loadRegistry,
  planMergeBack,
  planSync,
  saveRegistry,
  sessionportHome,
  SESSION_AGENTS,
  sourceKeyOf,
  upsertRef,
  validateIrBundle,
} from '@sessionport/core';
import type { AdapterWriteOutcome, AgentAdapter, AgentId, CursorUndoInfo, ExternalRef, HistoryAction, HistoryRecord, SyncDecision } from '@sessionport/core';
import type { IrBundle, IrNotice } from '@sessionport/core';
import { getAdapter, prefixTable, WRITE_TARGETS } from './adapters.ts';
import { openTargetApp, planOfficialImport, officialSupport, verifyOfficialImport, type OfficialTarget } from './official.ts';

const USAGE = [
  'sessionport — 在 AI 编程 agent 之间搬运会话',
  '',
  '用法:',
  '  sessionport inspect <source>',
  '  sessionport pull <source> [--out ir.json]',
  '  sessionport push <source> --to <agent> [options]',
  '  sessionport sync <source> --to <agent> [options]   # 安全重推：不覆盖目标端新增内容',
  '  sessionport merge-back <source> --from <agent> [options]',
  '                        把目标端续写出来的新轮次增量合并回源会话（默认无损尾部追加）',
  '  sessionport undo [<opId>] [--list] [--dry-run] [--state <dir>]',
  '                        撤销最近一次（或指定 id）写操作，恢复被改写/新建的会话与 registry',
  '  sessionport status [--state <dir>] [--json]',
  '                        查看所有已登记会话的同步状态与建议操作',
  '  sessionport verify --agent <agent> [options]',
  '  sessionport list [--agent <agent>] [--limit <n>] [--json]',
  '  sessionport import --into <zcode|qoder> <source> [--open] [--verify]',
  '                        复用目标 app 自带的官方会话导入（准备源 + 引导 + 事后验证）',
  '',
  '<source> 形式:',
  '  kimi:<目录>            Kimi Code 会话目录（kimi export 解包目录或原生会话目录）',
  '  claude:<路径|id>       Claude Code transcript（~/.claude/projects/.../<uuid>.jsonl）',
  '  commandcode:<路径>     Command Code transcript（.jsonl）或会话 id',
  '  dsh:<目录>             DSH 会话目录（含 session.v4.jsonl.zstd）',
  '  codex:<路径|id>        Codex rollout（sessions/**/rollout-*.jsonl）或会话 id',
  '  opencode:<路径|id>     opencode 导出 JSON 或会话 id（ses_…）',
  '  cursor:<id>            Cursor composer id（state.vscdb 内的 composerId）',
  '  qoder:<路径|id>        Qoder CN transcript（~/.qoder-cn/projects/.../<uuid>.jsonl）',
  '  workbuddy:<路径|id>    WorkBuddy transcript（~/.workbuddy/projects/...，只读）',
  '  antigravity:<路径|id>  Antigravity 对话（~/.gemini/antigravity/brain/...，兼容 agy CLI，只读）',
  '  <ir.json>              已有 IR 文件',
  '  <无前缀目录/文件>      按结构自动识别',
  '',
  '目标 agent（--to）:',
  '  claude-code  |  command-code  |  dsh  |  codex  |  opencode  |  cursor  |  qoder',
  '',
  '通用选项:',
  '  --home <dir>           目标数据根目录（claude: 配置目录；command-code: ~/.commandcode；dsh: DSH_HOME）',
  '  --cwd <dir>            目标会话的工作目录（默认取源会话 cwd）',
  '  --id <id>              指定目标会话 id',
  '  --model <name>         目标模型名',
  '  --title <text>         目标会话标题',
  '  --dry-run              只生成不落盘',
  '  --register             写完顺带注册进目标 app：dsh 写 workspace.json，command-code 写 thread-index.db + app-state.json',
  '  --user-data-dir <dir>  command-code 桌面端数据目录覆盖（默认 ~/Library/Application Support/Command Code）',
  '  --write-ir <file>      同时把 IR 落盘',
  '  --json                 输出机器可读 JSON',
  '  --force                sync: 目标端有新增时仍然覆盖（会丢目标端新内容）',
  '  --confirm-real         写 Cursor 真实库时必须显式确认（先用 --dry-run 看计划）',
  '  --include-children     子代理会话一并导出（dsh / claude-code / command-code / qoder 支持；其余记入损失清单）',
  '  --synthesize-agent-calls  源端缺触发子代理的调用时，补一对合成的 Agent 调用（claude-code；默认关，会记一条 info 损失）',
  '  --keep-injected        保留源端注入消息（默认在支持的目标上丢弃并记损失）',
  '  --raw-tools            关闭工具语义归一（默认把工具调用改写为目标端原生工具）',
  '  --slim                 dsh 目标精简导入：截断 tool_result/参数、丢弃较早 reasoning（日志也损）',
  '  --compact              dsh 目标压缩导入：保留全部事件日志，写 DSH 原生 compaction（摘要+最近 step）',
  '  --compact-budget-chars <n>  压缩导入时可见上下文（最近 step）的字符预算（默认 200000）',
  '  --compact-keep-steps <n>    强制保留最近 n 个 step（默认按预算自适应）',
  '  --summary-llm <claude|codex>  压缩导入时用已登录的 CLI 生成 LLM 多轮摘要',
  '  --summary-cmd <命令>        自定义摘要命令（prompt 走 stdin，stdout 读摘要）',
  '  --into <app>           import 的目标 app：zcode | qoder | cursor（cursor 无官方导入）',
  '  --open                 import 时自动打开目标 app',
  '  --fork                 sync: 目标端有新增时另建一个目标会话，保留旧会话',
  '  --merge-back           sync: 目标端有新增时改为把目标新增内容合并回源会话',
  '  --from <agent>         merge-back 的目标端 harness（也可用 --to）',
  '  --target-home <dir>    merge-back 时目标端非默认数据目录（--home 为源端覆盖）',
  '  --append-diverged      merge-back: 双方同步后都推进时仍写入（加 fork 边界）',
  '  --list                 undo: 列出可撤销的操作历史',
  '  --state <dir>          registry 与 history 目录（默认 $SESSIONPORT_HOME 或 ~/.sessionport）',
  '  --limit <n>            list: 最多显示多少条（默认 200）',
  '',
  'claude-code 专属:',
  '  --config-dir <dir>     --home 的别名；--version <ver>；--keep-thinking（thinking 降级为 text）',
  '',
  'verify 选项:',
  '  --agent <agent>        要校验的目标 agent',
  '  --file <path>          command-code 的 transcript 路径',
  '  --resume               额外跑一次无头 resume（claude-code / command-code，会真实调用模型）',
].join('\n');

function fail(message: string): never {
  process.stderr.write('错误: ' + message + '\n');
  process.exit(1);
}

interface SourceKind {
  kind: AgentId | 'ir';
  target: string;
}

function detectSource(raw: string): SourceKind {
  for (const [prefix, kind] of prefixTable()) {
    const tag = prefix + ':';
    if (raw.startsWith(tag)) return { kind, target: raw.slice(tag.length) };
  }
  if (raw.endsWith('.json') && existsSync(raw) && !existsSync(join(raw, 'state.json'))) return { kind: 'ir', target: raw };
  if (existsSync(join(raw, 'state.json'))) return { kind: 'kimi-code', target: raw };
  if (
    existsSync(join(raw, '.system_generated', 'logs', 'transcript_full.jsonl')) ||
    existsSync(join(raw, '.system_generated', 'logs', 'transcript.jsonl')) ||
    existsSync(join(raw, 'transcript_full.jsonl'))
  ) {
    return { kind: 'antigravity', target: raw };
  }
  if (existsSync(join(raw, 'session.v4.jsonl.zstd'))) return { kind: 'dsh', target: raw };
  if (raw.endsWith('.jsonl.zstd')) return { kind: 'dsh', target: raw };
  if (raw.endsWith('.jsonl')) {
    // rollout 与 Command Code / Antigravity transcript 都是 .jsonl，按首行或文件名区分
    if (raw.endsWith('/transcript_full.jsonl') || raw === 'transcript_full.jsonl') {
      return { kind: 'antigravity', target: raw };
    }
    try {
      const first = readFileSync(raw, 'utf8').split('\n', 1)[0] ?? '';
      if (first.includes('"session_meta"')) return { kind: 'codex', target: raw };
      if (first.includes('"session-meta"')) return { kind: 'workbuddy', target: raw };
      if (first.includes('"workspace-directories"')) return { kind: 'qoder', target: raw };
      if (
        first.includes('"step_index"') &&
        (first.includes('"USER_INPUT"') || first.includes('"PLANNER_RESPONSE"') || first.includes('"SYSTEM_MESSAGE"') || first.includes('"CHECKPOINT"'))
      ) {
        return { kind: 'antigravity', target: raw };
      }
      if (first.includes('"parentUuid"') || (first.includes('"sessionId"') && first.includes('"cwd"'))) return { kind: 'claude-code', target: raw };
    } catch {
      // 读不到就按后缀兜底
    }
    return { kind: 'command-code', target: raw };
  }
  if (existsSync(raw) && existsSync(join(raw, 'agents'))) return { kind: 'kimi-code', target: raw };
  fail('无法识别的 source: ' + raw + '（可以显式加 antigravity: / kimi: / commandcode: / dsh: 前缀）');
}

async function loadBundle(source: string): Promise<IrBundle> {
  const detected = detectSource(source);
  if (detected.kind === 'ir' && detected.target.endsWith('.json')) {
    // IR 与 opencode 导出都是 .json：先按 IR 校验，失败再当 opencode 导出
    try {
      const parsed = JSON.parse(readFileSync(detected.target, 'utf8')) as { irVersion?: unknown; info?: unknown; messages?: unknown };
      if (parsed.irVersion === undefined && parsed.info !== undefined && Array.isArray(parsed.messages)) {
        const mod = await import('@sessionport/adapter-opencode');
        return mod.exportToBundle(parsed as never);
      }
    } catch {
      // 落到下面的 IR 处理
    }
  }
  if (detected.kind === 'ir') {
    const bundle = JSON.parse(readFileSync(detected.target, 'utf8')) as IrBundle;
    const errors = validateIrBundle(bundle);
    if (errors.length > 0) fail('IR 校验失败:\n  ' + errors.join('\n  '));
    return bundle;
  }
  const adapter = await getAdapter(detected.kind);
  if (!adapter?.read) fail('不支持的源 agent: ' + detected.kind);
  return adapter.read(detected.target);
}

function printNotices(notices: IrNotice[]): void {
  if (notices.length === 0) return;
  process.stdout.write('notices:\n');
  for (const n of notices) {
    process.stdout.write('  [' + n.severity + '] ' + n.code + ' x' + (n.count ?? 1) + ' — ' + n.message + '\n');
  }
}

function summarize(bundle: IrBundle): string {
  const lines: string[] = [];
  lines.push('IR v' + bundle.irVersion + '  sessions=' + (1 + bundle.children.length) + '  events=' + bundleEventCount(bundle));
  lines.push('root ' + bundle.root.id + '  events=' + bundle.root.events.length + '  cwd=' + (bundle.root.meta.cwd ?? '?'));
  lines.push('  title=' + (bundle.root.meta.title ?? '(none)') + '  model=' + (bundle.root.meta.model ?? '?'));
  lines.push('root kinds: ' + JSON.stringify(eventKindCounts(bundle.root)));
  for (const child of bundle.children) {
    const parts = ['child ' + child.session.id, 'events=' + child.session.events.length, 'label=' + (child.label ?? '?')];
    if (child.session.meta.profile !== undefined) parts.push('profile=' + child.session.meta.profile);
    if (child.session.meta.title !== undefined) parts.push('title=' + child.session.meta.title.slice(0, 60));
    if (child.viaToolCallId !== undefined) parts.push('via=' + child.viaToolCallId);
    lines.push(parts.join('  '));
  }
  lines.push('root source: ' + JSON.stringify(bundle.root.source));
  return lines.join('\n');
}

const SUMMARY_PRESETS: Record<string, string> = {
  claude: 'claude -p',
  codex: 'codex exec -',
};

function resolveSummaryCommand(values: Record<string, string | boolean | undefined>): string | undefined {
  if (typeof values['summary-cmd'] === 'string' && values['summary-cmd'].trim().length > 0) return values['summary-cmd'];
  if (typeof values['summary-llm'] === 'string') {
    const preset = SUMMARY_PRESETS[values['summary-llm'].trim().toLowerCase()];
    if (preset === undefined) fail('未知 --summary-llm: ' + values['summary-llm'] + '（可选 claude / codex）');
    return preset;
  }
  return undefined;
}

function commonTargetOptions(values: Record<string, string | boolean | undefined>): Record<string, unknown> {
  return {
    home: typeof values.home === 'string' ? values.home : typeof values['config-dir'] === 'string' ? values['config-dir'] : undefined,
    cwd: typeof values.cwd === 'string' ? values.cwd : undefined,
    id: typeof values.id === 'string' ? values.id : typeof values['session-id'] === 'string' ? values['session-id'] : undefined,
    model: typeof values.model === 'string' ? values.model : undefined,
    title: typeof values.title === 'string' ? values.title : undefined,
    registerWorkspace: Boolean(values.register),
    register: Boolean(values.register),
    keepInjected: Boolean(values['keep-injected']),
    includeChildren: Boolean(values['include-children']),
    synthesizeAgentCalls: Boolean(values['synthesize-agent-calls']),
    normalizeTools: values['raw-tools'] !== true,
    version: typeof values.version === 'string' ? values.version : undefined,
    keepThinking: Boolean(values['keep-thinking']),
    userDataDir: typeof values['user-data-dir'] === 'string' ? values['user-data-dir'] : undefined,
    dryRun: Boolean(values['dry-run']),
    confirmReal: Boolean(values['confirm-real']),
    slim: Boolean(values.slim),
    compact: Boolean(values.compact),
    compactBudgetChars:
      typeof values['compact-budget-chars'] === 'string' ? Number(values['compact-budget-chars']) : undefined,
    compactKeepRecentSteps:
      typeof values['compact-keep-steps'] === 'string' ? Number(values['compact-keep-steps']) : undefined,
    summaryCommand: resolveSummaryCommand(values),
  };
}

function printReport(report: {
  target: string;
  sessionId: string;
  paths: string[];
  written?: { events: number; messages: number; toolCalls: number; toolResults: number; reasoning: number };
  losses?: Array<{ severity: string; code: string; count: number; message: string }>;
}): void {
  process.stdout.write('target      ' + report.target + '\n');
  process.stdout.write('session     ' + report.sessionId + '\n');
  for (const p of report.paths) process.stdout.write('path        ' + p + '\n');
  if (report.written) {
    process.stdout.write(
      'written     events=' + report.written.events +
        ' messages=' + report.written.messages +
        ' tool_calls=' + report.written.toolCalls +
        ' tool_results=' + report.written.toolResults +
        ' reasoning=' + report.written.reasoning + '\n',
    );
  }
  const losses = report.losses ?? [];
  process.stdout.write('losses      ' + (losses.length === 0 ? 'none' : '') + '\n');
  for (const loss of losses) process.stdout.write('  [' + loss.severity + '] ' + loss.code + ' x' + loss.count + ' — ' + loss.message + '\n');
}

async function readTargetBundle(
  agent: AgentId,
  targetId: string,
  targetPath?: string,
  targetHome?: string,
): Promise<IrBundle> {
  if (agent === 'cursor') {
    const cursorInput = targetPath ? targetPath + '#' + targetId : targetId;
    const adapter = await getAdapter('cursor');
    if (!adapter?.read) fail('cursor adapter 缺少 read');
    return adapter.read(cursorInput);
  }
  if (agent === 'opencode') {
    if (targetHome !== undefined && targetHome.length > 0) {
      const mod = await import('@sessionport/adapter-opencode');
      const raw = await mod.exportOpencodeSession(targetId, { env: { XDG_DATA_HOME: targetHome } });
      return mod.exportToBundle(raw);
    }
    const adapter = await getAdapter('opencode');
    if (!adapter?.read) fail('opencode adapter 缺少 read');
    return adapter.read(targetId);
  }
  const adapter = await getAdapter(agent);
  if (!adapter?.read) fail('不支持读取目标 agent: ' + agent);
  return adapter.read(targetPath ?? targetId);
}

function inferHomeFromPath(agent: AgentId, filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;
  const abs = resolve(filePath);
  if (agent === 'claude-code' || agent === 'command-code' || agent === 'qoder') {
    // <home>/projects/<slug>/<id>.jsonl
    return dirname(dirname(dirname(abs)));
  }
  if (agent === 'dsh') {
    // <home>/sessions/<id>/session.v4.jsonl.zstd
    return dirname(dirname(dirname(abs)));
  }
  if (agent === 'codex') {
    // <home>/sessions/YYYY/MM/DD/rollout-*.jsonl
    return dirname(dirname(dirname(dirname(dirname(abs)))));
  }
  return undefined;
}

function buildBackupCaveats(target: AgentId, opts: Record<string, unknown>): string[] {
  const caveats: string[] = [];
  if (target === 'opencode') {
    caveats.push('opencode 会话写入共享数据库/外部进程，sessionport undo 仅还原 registry 而不回滚 opencode 库内消息');
  }
  if (opts.register === true || opts.registerWorkspace === true) {
    caveats.push('--register 写入了目标应用索引（如 threads/session_index.jsonl/app-state.json/workspace.json），undo 不自动删除索引条目');
  }
  return caveats;
}

async function writeWithBackup(input: {
  action: HistoryAction;
  target: AgentId;
  adapter: AgentAdapter & { write: NonNullable<AgentAdapter['write']> };
  bundle: IrBundle;
  opts: Record<string, unknown>;
  sourceKey: string;
  id?: string;
  dryRun: boolean;
  includeRegistry: boolean;
  previewOutcome?: AdapterWriteOutcome;
  afterWrite?: (outcome: AdapterWriteOutcome) => Promise<void> | void;
}): Promise<{ outcome: AdapterWriteOutcome; backupRecord?: HistoryRecord }> {
  if (input.dryRun) {
    const outcome = await input.adapter.write(input.bundle, { ...input.opts, id: input.id, dryRun: true });
    return { outcome };
  }

  const preview =
    input.previewOutcome ??
    (await input.adapter.write(input.bundle, { ...input.opts, id: input.id, dryRun: true }));
  const lockedId = input.id ?? preview.targetId;
  const lockedOpts: Record<string, unknown> = {
    ...input.opts,
    id: lockedId,
    dryRun: false,
    ...(input.target === 'codex' && typeof input.opts.targetPath !== 'string' && preview.paths[0]
      ? { targetPath: preview.paths[0] }
      : {}),
  };

  const plannedPaths =
    input.target === 'cursor' || input.target === 'opencode' ? [] : collectOutcomePaths(preview);
  const handle = beginBackup({
    stateHome: typeof input.opts.stateHome === 'string' ? input.opts.stateHome : undefined,
    action: input.action,
    sourceKey: input.sourceKey,
    target: input.target,
    targetId: lockedId,
    targetHome: typeof input.opts.home === 'string' ? input.opts.home : undefined,
    plannedPaths,
    includeRegistry: input.includeRegistry,
    caveats: buildBackupCaveats(input.target, lockedOpts),
  });

  if (input.target === 'cursor' && lockedOpts.backupDir === undefined) {
    lockedOpts.backupDir = handle.cursorBackupDir;
  }

  try {
    const outcome = await input.adapter.write(input.bundle, lockedOpts);
    if (input.afterWrite) await input.afterWrite(outcome);
    const cursor: CursorUndoInfo | undefined =
      input.target === 'cursor'
        ? {
            dbPath: outcome.paths[0] ?? '',
            composerId: outcome.targetId,
            ...(typeof outcome.report.backupPath === 'string' ? { backupPath: outcome.report.backupPath } : {}),
          }
        : undefined;
    const backupRecord = handle.finalize({
      targetId: outcome.targetId,
      actualPaths: input.target === 'cursor' || input.target === 'opencode' ? [] : collectOutcomePaths(outcome),
      ...(cursor !== undefined ? { cursor } : {}),
    });
    return { outcome, backupRecord };
  } catch (error) {
    handle.abort();
    throw error;
  }
}

async function cmdPush(source: string, values: Record<string, string | boolean | undefined>): Promise<void> {
  const to = typeof values.to === 'string' ? values.to : '';
  if (!to) fail('push 需要 --to <agent>（' + WRITE_TARGETS.join(' / ') + '）');
  const adapter = await getAdapter(to);
  if (!adapter?.write) fail('不支持的目标 agent: ' + to);
  const bundle = await loadBundle(source);
  const totalEvents = bundle.root.events.length + bundle.children.reduce((sum, child) => sum + child.session.events.length, 0);
  if (to === 'dsh' && values.slim !== true && values.compact !== true && totalEvents > 400) {
    process.stderr.write(
      '提示：会话较大（' + totalEvents + ' 事件），全量导入可能超出目标模型上下文。' +
        '建议加 --compact（保留完整日志 + 压缩上下文），高保真可用 --compact --summary-llm claude。\n',
    );
  }

  if (typeof values['write-ir'] === 'string') {
    writeFileSync(values['write-ir'] as string, JSON.stringify(bundle, null, 2) + '\n', 'utf8');
  }
  const opts = commonTargetOptions(values);
  opts.stateHome = typeof values.state === 'string' ? values.state : undefined;
  const sourceKey = sourceKeyOf(bundle.root.source, bundle.root.id);
  const id = typeof opts.id === 'string' ? opts.id : undefined;
  const dryRun = Boolean(values['dry-run']);
  const { outcome, backupRecord } = await writeWithBackup({
    action: 'push',
    target: to as AgentId,
    adapter: adapter as AgentAdapter & { write: NonNullable<AgentAdapter['write']> },
    bundle,
    opts,
    sourceKey,
    id,
    dryRun,
    includeRegistry: false,
  });

  if (values.json) {
    process.stdout.write(
      JSON.stringify({ ...outcome.report, ...(backupRecord ? { backupId: backupRecord.id } : {}) }, null, 2) + '\n',
    );
    return;
  }
  const report: Parameters<typeof printReport>[0] = {
    ...outcome.report,
    target: outcome.target,
    sessionId: outcome.targetId,
    paths: outcome.paths,
  };
  printReport(report);
  if (backupRecord) {
    process.stdout.write('backup      ' + backupRecord.id + '  (可用 sessionport undo 回滚)\n');
  }
  printNotices(bundle.root.notices);
  process.stdout.write('\n下一步: 用目标 agent 打开/继续这个会话（' + report.paths[0] + '）\n');
}

async function writeTarget(
  target: string,
  bundle: IrBundle,
  opts: Record<string, unknown>,
  id: string | undefined,
  dryRun: boolean,
): Promise<AdapterWriteOutcome> {
  const adapter = await getAdapter(target);
  if (!adapter?.write) fail('不支持的目标 agent: ' + target);
  return adapter.write(bundle, { ...opts, id, dryRun });
}

async function countTarget(
  target: string,
  outcome: AdapterWriteOutcome,
  opts: Record<string, unknown>,
): Promise<{ exists: boolean; units: number }> {
  const adapter = await getAdapter(target);
  if (!adapter?.countTarget) return { exists: false, units: 0 };
  return adapter.countTarget(outcome, opts);
}

async function cmdSync(source: string, values: Record<string, string | boolean | undefined>): Promise<void> {
  const to = typeof values.to === 'string' ? values.to : '';
  if (!to) fail('sync 需要 --to <agent>（claude-code / command-code / dsh）');
  if (values['merge-back'] === true) {
    await cmdMergeBack(source, {
      ...values,
      from: to,
      'target-home': values['target-home'] ?? values.home,
      home: undefined,
    });
    return;
  }
  const adapter = await getAdapter(to);
  if (!adapter?.write) fail('不支持的目标 agent: ' + to);
  const detected = detectSource(source);
  const bundle = await loadBundle(source);
  const opts = commonTargetOptions(values);
  const stateHome = typeof values.state === 'string' ? values.state : undefined;
  opts.stateHome = stateHome;
  const registry = loadRegistry(stateHome);
  const sourceKey = sourceKeyOf(bundle.root.source, bundle.root.id);
  const ref: ExternalRef | undefined = findRef(registry, sourceKey, to as never);
  if (ref !== undefined) opts.targetPath = ref.targetPath;

  // 用 dry-run 先算出「如果现在写，会写到哪、有多少单位」
  const targetIdInput = ref?.targetId ?? (typeof opts.id === 'string' ? opts.id : undefined);
  const preview = await writeTarget(to, bundle, opts, targetIdInput, true);
  const current = await countTarget(to, preview, opts);

  const decision: SyncDecision = planSync({
    ref,
    source: { head: bundle.root.head, events: bundle.root.events.length },
    target: { exists: current.exists, units: current.units },
  });

  process.stdout.write('source      ' + sourceKey + '  events=' + bundle.root.events.length + '  head=' + (bundle.root.head ?? '-') + '\n');
  process.stdout.write('target      ' + to + (ref ? '  id=' + ref.targetId : '') + '\n');
  process.stdout.write('decision    ' + describeDecision(decision) + '\n');

  const diverged = decision.kind === 'diverged';
  const force = Boolean(values.force);
  const fork = Boolean(values.fork);
  if (diverged && !force && !fork) {
    process.stderr.write(
      '\n拒绝写入：目标端在上次同步后新增了 ' + decision.targetExtra + ' 单位。\n' +
      '  --fork        另建目标会话，保留旧会话（推荐）\n' +
      '  --merge-back  把目标端新增对话增量合并回源会话\n' +
      '  --force       直接覆盖（目标端新增内容会丢）\n',
    );
    process.exit(2);
  }
  if (decision.kind === 'up-to-date') {
    process.stdout.write('没有写入。\n');
    return;
  }

  const useFork = diverged && fork;
  const targetId = useFork ? undefined : targetIdInput;
  if (useFork) {
    process.stdout.write('fork      为当前源快照新建目标会话（旧会话保持不动）\n');
    delete opts.targetPath;
  }

  // 只新增型目标（cursor/qoder）在 refresh/force 覆盖时需要显式允许
  if (to === 'cursor') {
    opts.confirmReal = true;
    opts.allowOverwrite = true;
  }
  if (to === 'qoder') opts.overwrite = true;

  const dryRun = Boolean(values['dry-run']);
  let savedRegistryFile = '';
  const targetHome = typeof opts.home === 'string' ? opts.home : undefined;
  const sourcePath = bundle.root.source.nativePath ?? (detected.kind === 'ir' ? undefined : detected.target);
  const { outcome, backupRecord } = await writeWithBackup({
    action: 'sync',
    target: to as AgentId,
    adapter: adapter as AgentAdapter & { write: NonNullable<AgentAdapter['write']> },
    bundle,
    opts,
    sourceKey,
    id: targetId,
    dryRun,
    includeRegistry: true,
    previewOutcome: useFork ? undefined : preview,
    afterWrite: async (written) => {
      let targetIrEvents: number | undefined;
      let targetIrHead: string | null | undefined;
      let targetIrHeadHash: string | null | undefined;
      const writtenPath = written.paths[0] ? resolve(written.paths[0]) : '';
      try {
        const readBack = await readTargetBundle(to as AgentId, written.targetId, writtenPath, targetHome);
        targetIrEvents = readBack.root.events.length;
        targetIrHead = readBack.root.head;
        targetIrHeadHash = eventFingerprint(readBack.root.events.at(-1));
      } catch {
        // 无法回读目标（如 opencode 未安装）时留空，merge-back 自动回退内容指纹定位
      }
      const nextRef: ExternalRef = {
        sourceKey,
        target: to as never,
        targetId: written.targetId,
        targetPath: writtenPath,
        unit: written.unit,
        targetUnits: written.units,
        sourceEvents: bundle.root.events.length,
        sourceHead: bundle.root.head,
        updatedAt: new Date().toISOString(),
        sourceAgent: bundle.root.source.agent,
        ...(sourcePath !== undefined ? { sourcePath } : {}),
        ...(targetHome !== undefined ? { targetHome } : {}),
        ...(targetIrEvents !== undefined ? { targetIrEvents } : {}),
        ...(targetIrHead !== undefined ? { targetIrHead } : {}),
        ...(targetIrHeadHash !== undefined ? { targetIrHeadHash } : {}),
      };
      upsertRef(registry, nextRef);
      savedRegistryFile = saveRegistry(registry, stateHome);
    },
  });

  printReport(outcome.report as Parameters<typeof printReport>[0]);
  printNotices(bundle.root.notices);
  if (dryRun) {
    process.stdout.write('\n[dry-run] 未实际写入，未更新 registry。\n');
    return;
  }
  const latestRef = findRef(registry, sourceKey, to as never);
  process.stdout.write('\nregistry    ' + savedRegistryFile + '\n');
  if (backupRecord) process.stdout.write('backup      ' + backupRecord.id + '  (可用 sessionport undo 回滚)\n');
  if (latestRef) {
    process.stdout.write('已记录同步状态：sourceHead=' + (latestRef.sourceHead ?? '-') + ' sourceEvents=' + latestRef.sourceEvents + ' targetUnits=' + latestRef.targetUnits + '\n');
  }
}

async function cmdUndo(values: Record<string, string | boolean | undefined>, positionals: string[]): Promise<void> {
  const stateHome = typeof values.state === 'string' ? values.state : undefined;
  const limit = typeof values.limit === 'string' ? Number(values.limit) : 20;
  if (values.list === true) {
    const records = listHistory(stateHome, Number.isFinite(limit) && limit > 0 ? limit : 20);
    if (values.json) {
      process.stdout.write(JSON.stringify(records, null, 2) + '\n');
      return;
    }
    if (records.length === 0) {
      process.stdout.write('暂无备份历史记录。\n');
      return;
    }
    for (const r of records) {
      const stateTag = r.undoneAt ? 'undone' : 'active';
      process.stdout.write(
        r.id + '  [' + stateTag + ']  ' + r.action + '  ' + r.sourceKey + ' -> ' + r.target + ':' + r.targetId +
        '  files=' + r.files.length + (r.cursor ? '  cursor' : '') + '\n',
      );
    }
    return;
  }

  const targetOpId = positionals[0];
  const record = targetOpId ? loadHistoryRecord(targetOpId, stateHome) : latestUndoableRecord(stateHome);
  if (!record) {
    fail(targetOpId ? '找不到备份记录: ' + targetOpId : '没有可撤销的操作记录');
  }

  const dryRun = Boolean(values['dry-run']);
  const result = await applyUndo(record, {
    stateHome,
    dryRun,
    restoreCursor: async (backupPath) => {
      const mod = await import('@sessionport/adapter-cursor');
      mod.restoreCursorBackup(backupPath);
    },
  });

  if (values.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }
  process.stdout.write('undo        ' + result.opId + (result.dryRun ? '  [dry-run]' : '') + '\n');
  process.stdout.write('restored    ' + result.restoredFiles.length + ' files\n');
  for (const p of result.restoredFiles) process.stdout.write('  ↺ ' + p + '\n');
  process.stdout.write('deleted     ' + result.deletedFiles.length + ' files\n');
  for (const p of result.deletedFiles) process.stdout.write('  ✕ ' + p + '\n');
  if (result.missingFiles.length > 0) {
    process.stdout.write('missing     ' + result.missingFiles.length + ' files（已不存在）\n');
  }
  if (result.registryRestored) process.stdout.write('registry    已还原\n');
  if (result.registryDeleted) process.stdout.write('registry    已删除（操作前不存在）\n');
  if (result.cursorRestored) process.stdout.write('cursor      已事务级还原 composerHeaders 与 cursorDiskKV\n');
  for (const c of result.caveats) process.stdout.write('note        ' + c + '\n');
}

async function cmdMergeBack(source: string, values: Record<string, string | boolean | undefined>): Promise<void> {
  const from = typeof values.from === 'string' ? values.from : typeof values.to === 'string' ? values.to : '';
  if (!from) fail('merge-back 需要 --from <target>（也可用 --to <target>）');

  const detected = detectSource(source);
  if (detected.kind === 'ir') {
    fail('merge-back 需要原生可写源会话，不能直接合并回裸 IR 文件');
  }
  const sourceBundle = await loadBundle(source);
  const sourceAgent = sourceBundle.root.source.agent;
  const sourceAdapter = await getAdapter(sourceAgent);
  const sourceWritable = Boolean(sourceAdapter?.write);

  const stateHome = typeof values.state === 'string' ? values.state : undefined;
  const registry = loadRegistry(stateHome);
  const sourceKey = sourceKeyOf(sourceBundle.root.source, sourceBundle.root.id);
  const ref = findRef(registry, sourceKey, from as AgentId);

  if (ref === undefined) {
    const decision = planMergeBack({
      ref: undefined,
      source: sourceBundle.root,
      target: sourceBundle.root,
      sourceWritable,
    });
    if (values.json) process.stdout.write(JSON.stringify({ decision: decision.kind, message: describeMergeBackDecision(decision) }, null, 2) + '\n');
    fail(describeMergeBackDecision(decision));
  }

  const targetHome = typeof values['target-home'] === 'string' ? values['target-home'] : ref.targetHome;
  const targetBundle = await readTargetBundle(from as AgentId, ref.targetId, ref.targetPath, targetHome);
  const decision = planMergeBack({
    ref,
    source: sourceBundle.root,
    target: targetBundle.root,
    sourceWritable,
  });

  if (!values.json) {
    process.stdout.write('source      ' + sourceKey + '  events=' + sourceBundle.root.events.length + '  head=' + (sourceBundle.root.head ?? '-') + '\n');
    process.stdout.write('from        ' + from + ':' + ref.targetId + '  events=' + targetBundle.root.events.length + '\n');
    process.stdout.write('decision    ' + describeMergeBackDecision(decision) + '\n');
  }

  if (decision.kind === 'source-read-only' || decision.kind === 'unanchored') {
    if (values.json) process.stdout.write(JSON.stringify({ decision: decision.kind, message: describeMergeBackDecision(decision) }, null, 2) + '\n');
    fail(describeMergeBackDecision(decision));
  }
  if (decision.kind === 'up-to-date') {
    if (values.json) process.stdout.write(JSON.stringify({ decision: decision.kind, mergedEvents: 0 }, null, 2) + '\n');
    return;
  }

  const appendDiverged = values['append-diverged'] === true;
  if (decision.kind === 'both-changed' && !appendDiverged) {
    const msg = describeMergeBackDecision(decision);
    if (values.json) {
      process.stdout.write(JSON.stringify({ decision: decision.kind, refused: true, deltaEvents: decision.deltaEvents.length, sourceDelta: decision.sourceDelta, message: msg }, null, 2) + '\n');
    } else {
      process.stderr.write('\n拒绝回写：' + msg + '\n');
    }
    process.exit(2);
  }
  if (decision.kind !== 'fast-forward' && decision.kind !== 'both-changed') return;
  const deltaEvents = decision.deltaEvents;
  const decisionKind = decision.kind;

  const built = buildDeltaAndMergedBundles({
    sourceBundle,
    targetAgent: from as AgentId,
    targetId: ref.targetId,
    deltaEvents,
    normalizeTools: values['raw-tools'] !== true,
    includeDivergedBoundary: decisionKind === 'both-changed',
  });

  const sourcePath = sourceBundle.root.source.nativePath ?? ref.sourcePath ?? (existsSync(detected.target) ? resolve(detected.target) : undefined);
  const explicitSourceHome = typeof values.home === 'string' ? values.home : typeof values['config-dir'] === 'string' ? values['config-dir'] : undefined;
  const sourceHome = explicitSourceHome ?? ref.sourceHome ?? inferHomeFromPath(sourceAgent, sourcePath);
  const sourceId = sourceBundle.root.source.nativeSessionId ?? sourceBundle.root.id;
  const canAppend = Boolean(sourceAdapter?.appendDelta && sourcePath && existsSync(sourcePath));
  const strategy = canAppend ? 'appendDelta' : 'rewrite';
  const dryRun = Boolean(values['dry-run']);

  if (dryRun) {
    if (values.json) {
      process.stdout.write(
        JSON.stringify({ dryRun: true, decision: decisionKind, strategy, deltaEvents: deltaEvents.length, losses: built.losses, sourcePath }, null, 2) + '\n',
      );
    } else {
      process.stdout.write('strategy    ' + strategy + ' (dry-run)\n');
      process.stdout.write('delta       ' + deltaEvents.length + ' events -> ' + (sourcePath ?? sourceId) + '\n');
    }
    return;
  }

  let plannedPaths: string[] = [];
  if (sourceAgent !== 'cursor' && sourceAgent !== 'opencode') {
    if (strategy === 'appendDelta' && sourcePath) {
      plannedPaths = [sourcePath];
    } else {
      const previewWrite = await sourceAdapter!.write!(built.mergedBundle, {
        id: sourceId,
        home: sourceHome,
        cwd: sourceBundle.root.meta.cwd,
        targetPath: sourcePath,
        includeChildren: sourceBundle.children.length > 0,
        normalizeTools: false,
        dryRun: true,
      });
      plannedPaths = collectOutcomePaths(previewWrite);
      if (sourcePath && !plannedPaths.includes(resolve(sourcePath))) plannedPaths.unshift(resolve(sourcePath));
    }
  }

  const handle = beginBackup({
    stateHome,
    action: 'merge-back',
    sourceKey,
    target: sourceAgent,
    targetId: sourceId,
    targetHome: sourceHome,
    plannedPaths,
    includeRegistry: true,
    caveats: buildBackupCaveats(sourceAgent, {}),
  });

  try {
    const outcome =
      strategy === 'appendDelta'
        ? await sourceAdapter!.appendDelta!(sourcePath!, built.deltaBundle, {
            id: sourceId,
            home: sourceHome,
            cwd: sourceBundle.root.meta.cwd,
            model: sourceBundle.root.meta.model,
            normalizeTools: false,
            dryRun: false,
          })
        : await sourceAdapter!.write!(built.mergedBundle, {
            id: sourceId,
            home: sourceHome,
            dbPath: sourceAgent === 'cursor' ? sourcePath : undefined,
            targetPath: sourcePath,
            cwd: sourceBundle.root.meta.cwd,
            model: sourceBundle.root.meta.model,
            includeChildren: sourceBundle.children.length > 0,
            allowOverwrite: true,
            overwrite: true,
            confirmReal: true,
            backupDir: handle.cursorBackupDir,
            normalizeTools: false,
            dryRun: false,
          });

    const writtenSourcePath = outcome.paths[0] ? resolve(outcome.paths[0]) : sourcePath;
    const updatedSource = await readTargetBundle(sourceAgent, outcome.targetId, writtenSourcePath, sourceHome);
    const countedTarget = await countTarget(
      from,
      {
        target: from as AgentId,
        targetId: ref.targetId,
        paths: ref.targetPath ? [ref.targetPath] : [],
        unit: ref.unit,
        units: ref.targetUnits,
        report: {},
      },
      { home: targetHome, targetPath: ref.targetPath },
    );

    const nextRef: ExternalRef = {
      ...ref,
      sourceAgent,
      ...(writtenSourcePath !== undefined ? { sourcePath: writtenSourcePath } : {}),
      ...(sourceHome !== undefined ? { sourceHome } : {}),
      ...(targetHome !== undefined ? { targetHome } : {}),
      targetUnits: countedTarget.exists ? countedTarget.units : ref.targetUnits,
      sourceEvents: updatedSource.root.events.length,
      sourceHead: updatedSource.root.head,
      targetIrEvents: targetBundle.root.events.length,
      targetIrHead: targetBundle.root.head,
      targetIrHeadHash: eventFingerprint(targetBundle.root.events.at(-1)),
      updatedAt: new Date().toISOString(),
    };
    upsertRef(registry, nextRef);
    const registryFile = saveRegistry(registry, stateHome);

    const cursor: CursorUndoInfo | undefined =
      sourceAgent === 'cursor'
        ? {
            dbPath: outcome.paths[0] ?? '',
            composerId: outcome.targetId,
            ...(typeof outcome.report.backupPath === 'string' ? { backupPath: outcome.report.backupPath } : {}),
          }
        : undefined;
    const backupRecord = handle.finalize({
      targetId: outcome.targetId,
      actualPaths: sourceAgent === 'cursor' || sourceAgent === 'opencode' ? [] : collectOutcomePaths(outcome),
      ...(cursor !== undefined ? { cursor } : {}),
    });

    const allLosses = [...built.losses, ...((outcome.report.losses ?? []) as typeof built.losses)];
    if (values.json) {
      process.stdout.write(
        JSON.stringify(
          {
            decision: decisionKind,
            strategy,
            mergedEvents: deltaEvents.length,
            sourcePath: writtenSourcePath,
            backupId: backupRecord.id,
            losses: allLosses,
            registryFile,
          },
          null,
          2,
        ) + '\n',
      );
      return;
    }

    process.stdout.write('strategy    ' + strategy + '\n');
    process.stdout.write('merged      ' + deltaEvents.length + ' events -> ' + (writtenSourcePath ?? sourceId) + '\n');
    process.stdout.write('registry    ' + registryFile + '\n');
    process.stdout.write('backup      ' + backupRecord.id + '  (可用 sessionport undo 回滚)\n');
  } catch (error) {
    handle.abort();
    throw error;
  }
}

const AGENT_SOURCE_PREFIX: Record<AgentId, string> = {
  'claude-code': 'claude',
  'command-code': 'commandcode',
  'kimi-code': 'kimi',
  dsh: 'dsh',
  codex: 'codex',
  opencode: 'opencode',
  cursor: 'cursor',
  qoder: 'qoder',
  workbuddy: 'workbuddy',
  antigravity: 'antigravity',
};

interface StatusRow {
  sourceKey: string;
  sourceAgent?: AgentId;
  sourcePath?: string;
  target: AgentId;
  targetId: string;
  targetPath: string;
  state: 'up-to-date' | 'refresh' | 'fresh' | 'diverged' | 'source-missing';
  sourceEvents?: number;
  recordedSourceEvents: number;
  targetExists: boolean;
  targetUnits: number;
  recordedTargetUnits: number;
  targetExtra?: number;
  updatedAt: string;
  description: string;
  hint: string;
}

function inferSourceFromRef(ref: ExternalRef): { sourceAgent?: AgentId; sourceId: string } {
  const colon = ref.sourceKey.indexOf(':');
  const prefix = colon >= 0 ? ref.sourceKey.slice(0, colon) : '';
  const sourceId = colon >= 0 ? ref.sourceKey.slice(colon + 1) : ref.sourceKey;
  const known = SESSION_AGENTS.includes(prefix as AgentId) ? (prefix as AgentId) : undefined;
  return {
    sourceAgent: ref.sourceAgent ?? known,
    sourceId,
  };
}

async function cmdStatus(values: Record<string, string | boolean | undefined>): Promise<void> {
  const stateHome = typeof values.state === 'string' ? values.state : undefined;
  const registryFile = join(sessionportHome(stateHome), 'registry.json');
  const registry = loadRegistry(stateHome);
  const refs = [...registry.refs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const items: StatusRow[] = [];
  for (const ref of refs) {
    const { sourceAgent, sourceId } = inferSourceFromRef(ref);
    const targetCount = await countTarget(
      ref.target,
      {
        target: ref.target,
        targetId: ref.targetId,
        paths: ref.targetPath ? [ref.targetPath] : [],
        unit: ref.unit,
        units: ref.targetUnits,
        report: {},
      },
      { home: ref.targetHome, targetPath: ref.targetPath },
    ).catch(() => ({ exists: false, units: 0 }));

    const srcAdapter = sourceAgent ? await getAdapter(sourceAgent) : undefined;
    let sourceBundle: IrBundle | undefined;
    if (sourceAgent && srcAdapter?.read) {
      try {
        sourceBundle = await readTargetBundle(sourceAgent, sourceId, ref.sourcePath, ref.sourceHome);
      } catch {
        sourceBundle = undefined;
      }
    }

    if (sourceBundle === undefined) {
      const hint = targetCount.exists
        ? 'sessionport inspect "' + AGENT_SOURCE_PREFIX[ref.target] + ':' + (ref.targetPath || ref.targetId) + '"'
        : '源端与目标端均不可用';
      items.push({
        sourceKey: ref.sourceKey,
        ...(sourceAgent !== undefined ? { sourceAgent } : {}),
        ...(ref.sourcePath !== undefined ? { sourcePath: ref.sourcePath } : {}),
        target: ref.target,
        targetId: ref.targetId,
        targetPath: ref.targetPath,
        state: 'source-missing',
        recordedSourceEvents: ref.sourceEvents,
        targetExists: targetCount.exists,
        targetUnits: targetCount.units,
        recordedTargetUnits: ref.targetUnits,
        updatedAt: ref.updatedAt,
        description: '源会话无法读取（已移动、删除或未记录 sourcePath）',
        hint,
      });
      continue;
    }

    const decision = planSync({
      ref,
      source: { head: sourceBundle.root.head, events: sourceBundle.root.events.length },
      target: { exists: targetCount.exists, units: targetCount.units },
    });
    const sourceSpec = AGENT_SOURCE_PREFIX[sourceAgent!] + ':' + (ref.sourcePath || sourceId);
    let hint = '无需操作';
    if (decision.kind === 'refresh' || decision.kind === 'fresh') {
      hint = 'sessionport sync "' + sourceSpec + '" --to ' + ref.target;
    } else if (decision.kind === 'diverged') {
      hint = srcAdapter?.write
        ? 'sessionport merge-back "' + sourceSpec + '" --from ' + ref.target + '  或  sessionport sync "' + sourceSpec + '" --to ' + ref.target + ' --fork'
        : 'sessionport sync "' + sourceSpec + '" --to ' + ref.target + ' --fork';
    }

    items.push({
      sourceKey: ref.sourceKey,
      ...(sourceAgent !== undefined ? { sourceAgent } : {}),
      ...(ref.sourcePath !== undefined ? { sourcePath: ref.sourcePath } : {}),
      target: ref.target,
      targetId: ref.targetId,
      targetPath: ref.targetPath,
      state: decision.kind,
      sourceEvents: sourceBundle.root.events.length,
      recordedSourceEvents: ref.sourceEvents,
      targetExists: targetCount.exists,
      targetUnits: targetCount.units,
      recordedTargetUnits: ref.targetUnits,
      ...(decision.kind === 'diverged' ? { targetExtra: decision.targetExtra } : {}),
      updatedAt: ref.updatedAt,
      description: describeDecision(decision),
      hint,
    });
  }

  if (values.json) {
    process.stdout.write(JSON.stringify({ registryFile, total: items.length, items }, null, 2) + '\n');
    return;
  }

  if (items.length === 0) {
    process.stdout.write('暂无已登记的同步记录（' + registryFile + '）。\n');
    return;
  }

  process.stdout.write('registry    ' + registryFile + '（共 ' + items.length + ' 条）\n\n');
  for (const item of items) {
    process.stdout.write(
      '[' + item.state + '] ' + item.sourceKey + ' -> ' + item.target + ':' + item.targetId +
        '  (' + formatListTime(item.updatedAt) + ')\n',
    );
    process.stdout.write(
      '  sourceEvents=' + (item.sourceEvents ?? '-') + ' (recorded ' + item.recordedSourceEvents + ')' +
        '  targetUnits=' + item.targetUnits + ' (recorded ' + item.recordedTargetUnits + ')' +
        '  ' + item.description + '\n',
    );
    process.stdout.write('  建议: ' + item.hint + '\n');
  }
}


/** list --agent 的别名解析（大小写不敏感） */
const AGENT_ALIASES: Record<string, AgentId> = {
  'kimi-code': 'kimi-code',
  kimi: 'kimi-code',
  'claude-code': 'claude-code',
  claude: 'claude-code',
  'command-code': 'command-code',
  commandcode: 'command-code',
  cc: 'command-code',
  dsh: 'dsh',
  codex: 'codex',
  opencode: 'opencode',
  cursor: 'cursor',
  qoder: 'qoder',
  workbuddy: 'workbuddy',
  wb: 'workbuddy',
  antigravity: 'antigravity',
  agy: 'antigravity',
};

function resolveListAgent(raw: string): AgentId {
  const agent = AGENT_ALIASES[raw.trim().toLowerCase()];
  if (agent === undefined) fail('未知 agent: ' + raw + '（可选 ' + SESSION_AGENTS.join(' / ') + '）');
  return agent;
}

function formatListTime(iso: string | undefined): string {
  if (iso === undefined) return '-';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '-';
  const date = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}

/** sessionport list：汇总 6 家的会话元数据（不改动任何文件） */
/** sessionport import：复用目标 app 的官方导入（ZCode/Qoder 有，Cursor 没有） */
async function cmdOfficialImport(
  values: Record<string, string | boolean | undefined>,
  positionals: string[],
): Promise<void> {
  const into = typeof values.into === 'string' ? values.into : '';
  if (!into) fail('import 需要 --into <zcode|qoder|cursor>');
  if (!['zcode', 'qoder', 'cursor'].includes(into)) fail('未知目标: ' + into + '（可选 zcode / qoder / cursor）');
  const source = positionals[0] ?? (typeof values.source === 'string' ? values.source : '');
  if (!source) fail('import 需要 <source>（例如 claude:<id> / workbuddy:<id>）');
  const bundle = await loadBundle(source);
  const home = typeof values.home === 'string' ? values.home : undefined;
  const target = into as OfficialTarget;
  const support = officialSupport(target);

  if (!support.supported) {
    process.stdout.write(support.target + ' 没有官方导入路径。官方建议：用 sessionport push --to cursor --confirm-real 直接写入 composer。\n');
    for (const note of support.notes) process.stdout.write('  · ' + note + '\n');
    if (values.verify) process.exitCode = 2;
    return;
  }

  const result = await planOfficialImport({ target, bundle, home });
  if (values.open === true) {
    const opened = openTargetApp(target);
    process.stdout.write((opened ? 'open     ✅ 已打开 ' : 'open     ⚠️ 无法打开 ') + support.appName + '\n');
  }
  if (values.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }
  process.stdout.write('official import: ' + support.appName + '（' + support.mechanism + '）\n');
  process.stdout.write('source   ' + result.sourceAgent + (result.sourceTitle ? '  ' + result.sourceTitle : '') + '\n');
  process.stdout.write('prepare  ✅ ' + result.prepared + '\n');
  process.stdout.write('steps    在 ' + support.appName + ' 里操作：\n');
  result.steps.forEach((step, index) => process.stdout.write('  ' + (index + 1) + '. ' + step + '\n'));
  process.stdout.write('notes\n');
  for (const note of support.notes) process.stdout.write('  · ' + note + '\n');

  if (values.verify) {
    process.stdout.write('\n验证官方导入结果…\n');
    const verify = await verifyOfficialImport({ target, cwd: result.sourceCwd, title: result.sourceTitle, home });
    for (const line of verify.lines) process.stdout.write(line + '\n');
    process.stdout.write(verify.ok ? 'VERIFY: PASS（目标 app 存储里已找到）\n' : 'VERIFY: 未找到（可能还没在 app 里点导入）\n');
    if (!verify.ok) process.exitCode = 2;
  }
}
async function cmdList(values: Record<string, string | boolean | undefined>): Promise<void> {
  const agentFilter = typeof values.agent === 'string' ? resolveListAgent(values.agent) : undefined;
  let limit: number | undefined;
  if (typeof values.limit === 'string') {
    const parsed = Number(values.limit);
    if (!Number.isInteger(parsed) || parsed <= 0) fail('--limit 需要正整数');
    limit = parsed;
  }
  const home = typeof values.home === 'string' ? values.home : undefined;
  if (home !== undefined && agentFilter === undefined) {
    fail('--home 需要配合 --agent 使用（各 agent 的数据根目录规则不同）');
  }
  const homes = home !== undefined && agentFilter !== undefined ? ({ [agentFilter]: home } as Partial<Record<AgentId, string>>) : undefined;
  const result = await listAllSessions({ agents: agentFilter === undefined ? undefined : [agentFilter], homes, limit });
  for (const warning of result.warnings) process.stderr.write('warning: ' + warning + '\n');
  if (values.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }
  if (result.sessions.length === 0) {
    process.stdout.write('没有找到会话' + (agentFilter === undefined ? '' : '（' + agentFilter + '）') + '\n');
    return;
  }
  for (const session of result.sessions) {
    const title = (session.title ?? '(无标题)').replace(/\s+/gu, ' ').trim();
    process.stdout.write(
      session.agent.padEnd(13) + '  ' + formatListTime(session.updatedAt).padEnd(16) + '  ' + title + '  ' + session.sessionId + '\n',
    );
  }
  process.stdout.write('\n共 ' + result.sessions.length + ' 个会话' + (agentFilter === undefined ? '' : '（' + agentFilter + '）') + '\n');
}

async function cmdVerify(values: Record<string, string | boolean | undefined>): Promise<void> {
  const agent = typeof values.agent === 'string' ? values.agent : '';
  if (!agent) fail('verify 需要 --agent（claude-code / command-code / dsh）');
  const opts = commonTargetOptions(values);

  let result: { ok: boolean; checks: Array<{ name: string; ok: boolean; detail?: string }> };
  if (agent === 'claude-code') {
    const mod = await import('@sessionport/adapter-claude-code');
    const cwd = opts.cwd;
    const id = opts.id;
    if (typeof cwd !== 'string' || typeof id !== 'string') fail('claude-code 校验需要 --cwd 和 --id');
    const report = await mod.verifyClaudeSession({ configDir: opts.home as string | undefined, cwd, sessionId: id });
    result = { ok: report.ok, checks: report.checks };
    process.stdout.write('file: ' + report.filePath + '\nrows: ' + report.rows + '\n');
  } else if (agent === 'command-code') {
    const mod = await import('@sessionport/adapter-command-code');
    const file = typeof values.file === 'string' ? values.file : String(opts.id ?? '');
    if (!file) fail('command-code 校验需要 --file 或 --id');
    const report = await mod.verifyCommandCodeSession({ filePath: file });
    result = { ok: report.ok, checks: report.checks };
  } else if (agent === 'opencode') {
    const mod = await import('@sessionport/adapter-opencode');
    const file = typeof values.file === 'string' ? values.file : undefined;
    const id = typeof opts.id === 'string' ? opts.id : undefined;
    if (!file && !id) fail('opencode 校验需要 --file <导出 JSON> 或 --id <ses_…>');
    const opencodeHome = typeof values.home === 'string' ? values.home : undefined;
    const report = await mod.verifyOpencodeSession({
      filePath: file,
      sessionId: id,
      ...(opencodeHome !== undefined ? { env: { XDG_DATA_HOME: opencodeHome } } : {}),
    });
    result = { ok: report.ok, checks: report.checks };
  } else if (agent === 'codex') {
    const mod = await import('@sessionport/adapter-codex');
    const file = typeof values.file === 'string' ? values.file : typeof opts.id === 'string' ? opts.id : undefined;
    if (!file) fail('codex 校验需要 --file <rollout> 或 --id');
    const report = await mod.verifyCodexSession({ filePath: file, home: opts.home as string | undefined });
    result = { ok: report.ok, checks: report.checks };
  } else if (agent === 'cursor') {
    const mod = await import('@sessionport/adapter-cursor');
    const id = typeof opts.id === 'string' ? opts.id : '';
    if (!id) fail('cursor 校验需要 --id <composerId>');
    const report = await mod.verifyCursorSession({ home: opts.home as string | undefined, sessionId: id });
    result = { ok: report.ok, checks: report.checks };
  } else if (agent === 'qoder') {
    const mod = await import('@sessionport/adapter-qoder');
    const file = typeof values.file === 'string' ? values.file : String(opts.id ?? '');
    if (!file) fail('qoder 校验需要 --file 或 --id');
    const report = await mod.verifyQoderSession(file, { home: opts.home as string | undefined });
    result = { ok: report.ok, checks: report.checks };
  } else if (agent === 'workbuddy') {
    const mod = await import('@sessionport/adapter-workbuddy');
    const file = typeof values.file === 'string' ? values.file : String(opts.id ?? '');
    if (!file) fail('workbuddy 校验需要 --file 或 --id');
    const report = await mod.verifyWorkBuddySession(file, { home: opts.home as string | undefined });
    result = { ok: report.ok, checks: report.checks };
  } else if (agent === 'antigravity') {
    const mod = await import('@sessionport/adapter-antigravity');
    const file = typeof values.file === 'string' ? values.file : String(opts.id ?? '');
    if (!file) fail('antigravity 校验需要 --file 或 --id');
    const report = await mod.verifyAntigravitySession(file, { home: opts.home as string | undefined });
    result = { ok: report.ok, checks: report.checks };
  } else {
    const mod = await import('@sessionport/adapter-dsh');
    const id = opts.id;
    if (typeof id !== 'string') fail('dsh 校验需要 --id');
    const report = await mod.verifyDshSession({ home: opts.home as string | undefined, sessionId: id });
    result = { ok: report.ok, checks: report.checks };
  }

  for (const check of result.checks) {
    process.stdout.write('  ' + (check.ok ? 'PASS' : 'FAIL') + '  ' + check.name + (check.detail ? '  (' + check.detail + ')' : '') + '\n');
  }
  process.stdout.write(result.ok ? '结构化校验通过\n' : '结构化校验失败\n');

  if (values.resume) {
    if (agent === 'claude-code') {
      const mod = await import('@sessionport/adapter-claude-code');
      process.stdout.write('\n无头 resume 冒烟测试…\n');
      const smoke = await mod.resumeSmoke({
        configDir: opts.home as string | undefined,
        cwd: String(opts.cwd),
        sessionId: String(opts.id),
      });
      process.stdout.write('command: ' + smoke.command + '\n');
      process.stdout.write(smoke.ok ? 'RESUME SMOKE: PASS\n' : 'RESUME SMOKE: FAIL\n');
      if (!smoke.ok) process.exit(2);
    } else if (agent === 'opencode') {
      const mod = await import('@sessionport/adapter-opencode');
      const id = typeof opts.id === 'string' ? opts.id : undefined;
      if (!id) fail('opencode resume 冒烟需要 --id <ses_…>');
      const opencodeHome = typeof values.home === 'string' ? values.home : undefined;
      process.stdout.write('\n无头 resume 冒烟测试…\n');
      const smoke = await mod.resumeSmokeOpencode({
        sessionId: id,
        cwd: typeof opts.cwd === 'string' ? opts.cwd : undefined,
        model: typeof opts.model === 'string' ? opts.model : undefined,
        ...(opencodeHome !== undefined ? { env: { XDG_DATA_HOME: opencodeHome } } : {}),
      });
      process.stdout.write('command: ' + smoke.command + '\n');
      process.stdout.write('exit=' + String(smoke.exitCode) + ' timedOut=' + String(smoke.timedOut) + '\n');
      if (smoke.stdout) process.stdout.write('stdout: ' + String(smoke.stdout).slice(-1200) + '\n');
      if (smoke.stderr) process.stdout.write('stderr: ' + String(smoke.stderr).slice(-1200) + '\n');
      process.stdout.write(smoke.ok ? 'RESUME SMOKE: PASS\n' : 'RESUME SMOKE: FAIL\n');
      if (!smoke.ok) process.exit(2);
    } else if (agent === 'codex') {
      const mod = await import('@sessionport/adapter-codex');
      const file = typeof values.file === 'string' ? values.file : undefined;
      if (!file) fail('codex resume 冒烟需要 --file <rollout>');
      const home = typeof opts.home === 'string' ? opts.home : (mod.inferCodexHome(file) ?? process.env.CODEX_HOME ?? '');
      if (!home) fail('codex resume 冒烟需要 --home <CODEX_HOME>');
      const sessionId = mod.sessionIdFromRolloutPath(file) ?? file.split('/').pop()!.replace(/\.jsonl$/, '');
      // resume 用进程 cwd，不用 rollout 里的 cwd；默认跟着会话走
      let smokeCwd = typeof opts.cwd === 'string' ? opts.cwd : undefined;
      if (smokeCwd === undefined) {
        try {
          const headerLine = readFileSync(file, 'utf8').split('\n', 1)[0] ?? '';
          const header = JSON.parse(headerLine) as { payload?: { cwd?: string } };
          smokeCwd = header.payload?.cwd;
        } catch {
          smokeCwd = undefined;
        }
      }
      process.stdout.write('\n无头 resume 冒烟测试…\n');
      const smoke = await mod.resumeSmokeCodex({ home, sessionId, cwd: smokeCwd });
      process.stdout.write('command: ' + smoke.command + '\n');
      if (smoke.stdout) process.stdout.write('stdout: ' + String(smoke.stdout).slice(-1200) + '\n');
      if (smoke.stderr) process.stdout.write('stderr: ' + String(smoke.stderr).slice(-1200) + '\n');
      process.stdout.write(smoke.ok ? 'RESUME SMOKE: PASS\n' : 'RESUME SMOKE: FAIL\n');
      if (!smoke.ok) process.exit(2);
    } else if (agent === 'command-code') {
      const mod = await import('@sessionport/adapter-command-code');
      if (typeof mod.resumeSmokeCommandCode !== 'function') fail('该 adapter 还没有提供 resumeSmokeCommandCode');
      process.stdout.write('\n无头 resume 冒烟测试…\n');
      const smoke = await mod.resumeSmokeCommandCode({ filePath: typeof values.file === 'string' ? values.file : undefined });
      process.stdout.write('command: ' + smoke.command + '\n');
      if (smoke.stdout) process.stdout.write('stdout: ' + String(smoke.stdout).slice(-1200) + '\n');
      if (smoke.stderr) process.stdout.write('stderr: ' + String(smoke.stderr).slice(-1200) + '\n');
      process.stdout.write(smoke.ok ? 'RESUME SMOKE: PASS\n' : 'RESUME SMOKE: FAIL\n');
      if (!smoke.ok) process.exit(2);
    } else {
      const mod = await import('@sessionport/adapter-dsh');
      process.stdout.write('\nDSH headless resume 冒烟测试…\n');
      const home = mod.dshHome(typeof opts.home === 'string' ? opts.home : undefined);
      // 会话记录在源 cwd 下；headless CLI 会校验 cwd，必须跟着会话走
      let sessionCwd = typeof opts.cwd === 'string' ? opts.cwd : undefined;
      if (sessionCwd === undefined) {
        try {
          const bundle = await mod.readDshSession(String(opts.id), { home });
          sessionCwd = bundle.root.meta.cwd;
        } catch {
          sessionCwd = undefined;
        }
      }
      const smoke = await mod.resumeSmokeDsh({ home, sessionId: String(opts.id), cwd: sessionCwd });
      process.stdout.write('command: ' + smoke.command + '\n');
      process.stdout.write('loaded=' + String((smoke as { loaded?: boolean }).loaded) +
        ' turnStarted=' + String((smoke as { turnStarted?: boolean }).turnStarted) +
        ' missingCredential=' + String((smoke as { missingCredential?: boolean }).missingCredential) + '\n');
      if (smoke.stdout) process.stdout.write('stdout: ' + String(smoke.stdout).slice(-1500) + '\n');
      if (smoke.stderr) process.stdout.write('stderr: ' + String(smoke.stderr).slice(-1500) + '\n');
      process.stdout.write(smoke.ok ? 'RESUME SMOKE: PASS\n' : 'RESUME SMOKE: FAIL\n');
      if (!smoke.ok) process.exit(2);
    }
  }
  if (!result.ok) process.exit(2);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(USAGE + '\n');
    return;
  }
  const rest = argv.slice(1);
  const parsed = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      to: { type: 'string' },
      out: { type: 'string' },
      agent: { type: 'string' },
      file: { type: 'string' },
      home: { type: 'string' },
      'config-dir': { type: 'string' },
      cwd: { type: 'string' },
      id: { type: 'string' },
      'session-id': { type: 'string' },
      model: { type: 'string' },
      title: { type: 'string' },
      version: { type: 'string' },
      'keep-thinking': { type: 'boolean' },
      'keep-injected': { type: 'boolean' },
      'raw-tools': { type: 'boolean' },
      'include-children': { type: 'boolean' },
      'synthesize-agent-calls': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      register: { type: 'boolean' },
      'user-data-dir': { type: 'string' },
      'write-ir': { type: 'string' },
      'confirm-real': { type: 'boolean' },
      slim: { type: 'boolean' },
      compact: { type: 'boolean' },
      'compact-budget-chars': { type: 'string' },
      'compact-keep-steps': { type: 'string' },
      'summary-llm': { type: 'string' },
      'summary-cmd': { type: 'string' },
      into: { type: 'string' },
      source: { type: 'string' },
      open: { type: 'boolean' },
      verify: { type: 'boolean' },
      resume: { type: 'boolean' },
      force: { type: 'boolean' },
      fork: { type: 'boolean' },
      'merge-back': { type: 'boolean' },
      from: { type: 'string' },
      'target-home': { type: 'string' },
      'append-diverged': { type: 'boolean' },
      list: { type: 'boolean' },
      state: { type: 'string' },
      limit: { type: 'string' },
      json: { type: 'boolean' },
    },
  });
  const values = parsed.values as Record<string, string | boolean | undefined>;
  const positionals = parsed.positionals;

  if (command === 'inspect') {
    const source = positionals[0];
    if (!source) fail('inspect 需要 <source>');
    const bundle = await loadBundle(source);
    process.stdout.write(summarize(bundle) + '\n');
    printNotices(bundle.root.notices);
    for (const child of bundle.children) printNotices(child.session.notices);
    return;
  }
  if (command === 'pull') {
    const source = positionals[0];
    if (!source) fail('pull 需要 <source>');
    const bundle = await loadBundle(source);
    const body = JSON.stringify(bundle, null, 2);
    if (typeof values.out === 'string') {
      writeFileSync(values.out, body + '\n', 'utf8');
      process.stdout.write('IR 已写入 ' + resolve(values.out) + '（' + bundleEventCount(bundle) + ' 事件）\n');
    } else {
      process.stdout.write(body + '\n');
    }
    return;
  }
  if (command === 'push') {
    const source = positionals[0];
    if (!source) fail('push 需要 <source>');
    await cmdPush(source, values);
    return;
  }
  if (command === 'sync') {
    const source = positionals[0];
    if (!source) fail('sync 需要 <source>');
    await cmdSync(source, values);
    return;
  }
  if (command === 'merge-back') {
    const source = positionals[0];
    if (!source) fail('merge-back 需要 <source>');
    await cmdMergeBack(source, values);
    return;
  }
  if (command === 'undo') {
    await cmdUndo(values, positionals);
    return;
  }
  if (command === 'status') {
    await cmdStatus(values);
    return;
  }
  if (command === 'verify') {
    await cmdVerify(values);
    return;
  }
  if (command === 'import') {
    await cmdOfficialImport(values, positionals);
    return;
  }
  if (command === 'list') {
    await cmdList(values);
    return;
  }
  process.stdout.write(USAGE + '\n');
  fail('未知命令: ' + command);
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});