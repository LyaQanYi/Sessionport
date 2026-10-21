import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateIrBundle } from '@sessionport/core';
import type { IrEvent, IrMessageEvent } from '@sessionport/core';
import { readClaudeSession } from '../src/index.ts';

const SESSION_ID = 'ffffffff-6666-4666-8666-666666666666';
const AGENT_ID = 'c3333333cccccccc3';
const AGENT_WF = 'd4444444dddddddd4';
const TEST_CWD = '/tmp/sessionport-claude-subagents';

type FixtureRow = Record<string, unknown> | string;

function jsonl(values: FixtureRow[]): string {
  return values.map((value) => (typeof value === 'string' ? value : JSON.stringify(value))).join('\n') + '\n';
}

function projectDir(root: string): string {
  return join(root, 'projects', '-tmp-sessionport-claude-subagents');
}

async function writeMainSession(root: string, sessionId: string, lines: FixtureRow[]): Promise<string> {
  const dir = projectDir(root);
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, sessionId + '.jsonl');
  await writeFile(filePath, jsonl(lines), 'utf8');
  return filePath;
}

async function writeSubagent(
  root: string,
  sessionId: string,
  agentId: string,
  lines: FixtureRow[],
  options: { meta?: Record<string, unknown>; relativeDir?: string[]; journal?: FixtureRow[] } = {},
): Promise<string> {
  const dir = join(projectDir(root), sessionId, 'subagents', ...(options.relativeDir ?? []));
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, 'agent-' + agentId + '.jsonl');
  await writeFile(filePath, jsonl(lines), 'utf8');
  if (options.meta !== undefined) {
    await writeFile(filePath.replace(/\.jsonl$/u, '.meta.json'), JSON.stringify(options.meta), 'utf8');
  }
  if (options.journal !== undefined) {
    await writeFile(join(dir, 'journal.jsonl'), jsonl(options.journal), 'utf8');
  }
  return filePath;
}

function mainRows(): FixtureRow[] {
  return [
    {
      type: 'user',
      uuid: 'm1',
      sessionId: SESSION_ID,
      cwd: TEST_CWD,
      version: '2.1.303',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', content: '主会话问题' },
    },
    {
      type: 'assistant',
      uuid: 'm2',
      parentUuid: 'm1',
      sessionId: SESSION_ID,
      cwd: TEST_CWD,
      timestamp: '2026-01-01T00:00:09.000Z',
      message: { id: 'msg_main', role: 'assistant', model: 'claude-opus-4', content: [{ type: 'text', text: '主会话回复' }] },
    },
  ];
}

function agentRows(agentId: string, texts: string[]): FixtureRow[] {
  const rows: FixtureRow[] = [
    {
      type: 'user',
      parentUuid: null,
      isSidechain: true,
      agentId,
      uuid: agentId + '-a1',
      sessionId: SESSION_ID,
      cwd: TEST_CWD,
      timestamp: '2026-01-01T00:00:01.000Z',
      message: { role: 'user', content: texts[0] },
    },
    {
      type: 'assistant',
      parentUuid: agentId + '-a1',
      isSidechain: true,
      agentId,
      uuid: agentId + '-a2',
      sessionId: SESSION_ID,
      cwd: TEST_CWD,
      timestamp: '2026-01-01T00:00:02.000Z',
      message: {
        id: 'msg_' + agentId,
        role: 'assistant',
        model: 'claude-opus-4',
        content: [
          { type: 'text', text: texts[1] },
          { type: 'tool_use', id: 'tool_' + agentId, name: 'Bash', input: { command: 'ls' } },
        ],
      },
    },
    {
      type: 'user',
      parentUuid: agentId + '-a2',
      isSidechain: true,
      agentId,
      uuid: agentId + '-a3',
      sessionId: SESSION_ID,
      cwd: TEST_CWD,
      timestamp: '2026-01-01T00:00:03.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool_' + agentId, content: 'ok' }] },
    },
  ];
  if (texts[2] !== undefined) {
    rows.push({
      type: 'assistant',
      parentUuid: agentId + '-a3',
      isSidechain: true,
      agentId,
      uuid: agentId + '-a4',
      sessionId: SESSION_ID,
      cwd: TEST_CWD,
      timestamp: '2026-01-01T00:00:04.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: texts[2] }] },
    });
  }
  return rows;
}

function messageTexts(events: IrEvent[]): string[] {
  return events
    .filter((event): event is IrMessageEvent => event.kind === 'message')
    .map((event) => event.parts.filter((part) => part.type === 'text').map((part) => part.text).join(''));
}

test('subagents 目录：子代理 transcript 单独落盘时读成 children（meta 提供标题/profile/toolUseId）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sessionport-claude-subagents-'));
  try {
    const filePath = await writeMainSession(dir, SESSION_ID, mainRows());
    const childPath = await writeSubagent(dir, SESSION_ID, AGENT_ID, agentRows(AGENT_ID, ['子代理任务', '子代理执行', '子代理收尾']), {
      meta: { agentType: 'general-purpose', description: '检查测试覆盖', toolUseId: 'call_abc123' },
    });
    // 对照组：同样的主会话但没有 subagents 目录
    const plainPath = await writeMainSession(dir, 'aaaaaaaa-7777-4777-8777-777777777777', mainRows());

    const bundle = await readClaudeSession(filePath, { configDir: dir });
    const plain = await readClaudeSession(plainPath, { configDir: dir });

    assert.deepEqual(validateIrBundle(bundle), []);
    assert.deepEqual(bundle.root.events, plain.root.events);
    assert.equal(bundle.children.length, 1);

    const child = bundle.children[0]!;
    assert.equal(child.label, 'agent-' + AGENT_ID.slice(0, 8));
    assert.equal(child.parentSessionId, bundle.root.id);
    assert.equal(child.session.source.nativeSessionId, AGENT_ID);
    assert.equal(child.session.source.nativePath, childPath);
    assert.equal(child.session.meta.profile, 'general-purpose');
    assert.equal(child.session.meta.title, '检查测试覆盖');
    assert.equal(child.viaToolCallId, 'call_abc123');
    assert.deepEqual(
      child.session.events.map((event) => event.kind),
      ['message', 'message', 'tool_call', 'tool_result', 'message'],
    );
    assert.deepEqual(messageTexts(child.session.events), ['子代理任务', '子代理执行', '子代理收尾']);
    assert.ok(!child.session.notices.some((notice) => notice.code === 'claude.tool-without-result'));
    assert.ok(bundle.root.notices.some((notice) => notice.code === 'claude.subagent-transcripts' && notice.count === 1));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('subagents 目录：磁盘 transcript 覆盖主文件里的 sidechain 镜像行，不重复', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sessionport-claude-subagents-'));
  try {
    const inline = agentRows(AGENT_ID, ['子代理任务', '子代理执行']).slice(0, 2);
    const mainLines = [...mainRows(), ...inline];
    const filePath = await writeMainSession(dir, SESSION_ID, mainLines);
    await writeSubagent(dir, SESSION_ID, AGENT_ID, agentRows(AGENT_ID, ['子代理任务', '子代理执行', '镜像里没有的收尾']));

    const bundle = await readClaudeSession(filePath, { configDir: dir });

    assert.deepEqual(validateIrBundle(bundle), []);
    assert.equal(bundle.children.length, 1);
    const child = bundle.children[0]!;
    assert.deepEqual(messageTexts(child.session.events), ['子代理任务', '子代理执行', '镜像里没有的收尾']);
    assert.equal(child.session.events.filter((event) => event.kind === 'message').length, 3);
    assert.ok(!bundle.root.notices.some((notice) => notice.code === 'claude.subagent-mirror-extra-rows'));
    assert.ok(bundle.root.notices.some((notice) => notice.code === 'claude.subagent-transcripts'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('subagents 目录：workflows 嵌套 transcript 也能发现，journal label 当标题', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sessionport-claude-subagents-'));
  try {
    const filePath = await writeMainSession(dir, SESSION_ID, mainRows());
    const childPath = await writeSubagent(dir, SESSION_ID, AGENT_WF, agentRows(AGENT_WF, ['workflow 任务', 'workflow 执行']), {
      meta: { agentType: 'general-purpose', workflowPhase: 'Verify' },
      relativeDir: ['workflows', 'wf_test'],
      journal: [
        { type: 'launched' },
        { type: 'started', agentId: AGENT_WF, label: 'verify:subagent-discovery', phase: 'Verify' },
      ],
    });

    const bundle = await readClaudeSession(filePath, { configDir: dir });

    assert.deepEqual(validateIrBundle(bundle), []);
    assert.equal(bundle.children.length, 1);
    const child = bundle.children[0]!;
    assert.equal(child.session.source.nativePath, childPath);
    assert.equal(child.session.meta.title, 'verify:subagent-discovery');
    assert.equal(child.session.meta.profile, 'general-purpose');
    assert.equal(child.viaToolCallId, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('subagents 目录：坏行计入子会话 notice，不影响其它行', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sessionport-claude-subagents-'));
  try {
    const filePath = await writeMainSession(dir, SESSION_ID, mainRows());
    const rows = agentRows(AGENT_ID, ['子代理任务', '子代理执行']);
    await writeSubagent(dir, SESSION_ID, AGENT_ID, [...rows.slice(0, 1), 'not json', ...rows.slice(1)]);

    const bundle = await readClaudeSession(filePath, { configDir: dir });

    assert.equal(bundle.children.length, 1);
    const notice = bundle.children[0]!.session.notices.find((item) => item.code === 'claude.bad-json-lines');
    assert.equal(notice?.count, 1);
    assert.equal(bundle.children[0]!.session.events.length, 4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
