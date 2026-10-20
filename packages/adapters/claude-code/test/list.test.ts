import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listClaudeSessions } from '../src/index.ts';

function makeProject(): { root: string; dir: string; slug: string } {
  const root = mkdtempSync(join(tmpdir(), 'sessionport-claude-list-'));
  const slug = '-tmp-demo-proj';
  const dir = join(root, 'projects', slug);
  mkdirSync(dir, { recursive: true });
  return { root, dir, slug };
}

function jsonl(values: unknown[]): string {
  return values.map((value) => JSON.stringify(value)).join('\n') + '\n';
}

test('claude list: custom-title / cwd / 时间 / resumeHint', async () => {
  const { root, dir } = makeProject();
  try {
    const id = '11111111-1111-4111-8111-111111111111';
    writeFileSync(
      join(dir, id + '.jsonl'),
      jsonl([
        { type: 'mode', mode: 'normal', sessionId: id },
        { type: 'custom-title', customTitle: 'Claude 标题', sessionId: id },
        {
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: '请检查项目' }] },
          cwd: '/tmp/demo/proj',
          timestamp: '2026-10-01T00:00:00.000Z',
          sessionId: id,
        },
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '好的' }] }, timestamp: '2026-10-01T00:05:00.000Z', sessionId: id },
      ]),
    );
    const sessions = await listClaudeSessions({ home: root });
    assert.equal(sessions.length, 1);
    const session = sessions[0]!;
    assert.equal(session.agent, 'claude-code');
    assert.equal(session.sessionId, id);
    assert.equal(session.title, 'Claude 标题');
    assert.equal(session.cwd, '/tmp/demo/proj');
    assert.equal(session.createdAt, '2026-10-01T00:00:00.000Z');
    // updatedAt 用文件 mtime（Claude 是追加写，mtime 才是最后活动时间）
    assert.equal(session.updatedAt, statSync(join(dir, id + '.jsonl')).mtime.toISOString());
    assert.equal(session.resumeHint, 'claude --resume ' + id);
    assert.match(session.nativePath, new RegExp(id + '\\.jsonl$'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('claude list: 无标题行时取首条真实 user 文本（跳过注入/回灌）', async () => {
  const { root, dir } = makeProject();
  try {
    const id = '22222222-2222-4222-8222-222222222222';
    writeFileSync(
      join(dir, id + '.jsonl'),
      jsonl([
        { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '<local-command-caveat>ignore me' }] }, timestamp: '2026-10-01T00:00:00.000Z' },
        { type: 'user', isSidechain: true, message: { role: 'user', content: [{ type: 'text', text: 'sidechain 子代理' }] }, timestamp: '2026-10-01T00:00:01.000Z' },
        { type: 'user', toolUseResult: { ok: true }, message: { role: 'user', content: [{ type: 'text', text: '工具结果回灌' }] }, timestamp: '2026-10-01T00:00:02.000Z' },
        { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '真正的问题：为什么构建失败？' }] }, timestamp: '2026-10-01T00:00:03.000Z' },
      ]),
    );
    const sessions = await listClaudeSessions({ home: root });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]!.title, '真正的问题：为什么构建失败？');
    // 没有行内 cwd 时按 slug 反解；/tmp/demo/proj 不存在，因此不瞎猜
    assert.equal(sessions[0]!.cwd, undefined);
    assert.equal(sessions[0]!.createdAt, '2026-10-01T00:00:00.000Z');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('claude list: 标题追加在文件尾部时也能扫到（head+tail）', async () => {
  const { root, dir } = makeProject();
  try {
    const id = '33333333-3333-4333-8333-333333333333';
    const filler: unknown[] = [];
    for (let index = 0; index < 1200; index += 1) {
      filler.push({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'filler line ' + index + ' ' + 'x'.repeat(200) }] },
        timestamp: '2026-10-01T00:00:00.000Z',
      });
    }
    filler.push({ type: 'custom-title', customTitle: '后置标题', sessionId: id });
    writeFileSync(join(dir, id + '.jsonl'), jsonl(filler));
    const sessions = await listClaudeSessions({ home: root });
    assert.equal(sessions[0]!.title, '后置标题');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('claude list: 目录不存在返回 []，全坏文件跳过', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sessionport-claude-list-'));
  try {
    assert.deepEqual(await listClaudeSessions({ home: root }), []);
    const dir = join(root, 'projects', '-tmp-demo-proj');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'bad.jsonl'), 'not json\nalso not json\n');
    assert.deepEqual(await listClaudeSessions({ home: root }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('claude list: 标题优先级 custom-title > summary > 首条 user 文本', async () => {
  const { root, dir } = makeProject();
  try {
    const id = '44444444-4444-4444-8444-444444444444';
    writeFileSync(
      join(dir, id + '.jsonl'),
      jsonl([
        { type: 'summary', summary: '压缩摘要标题', sessionId: id },
        { type: 'user', message: { role: 'user', content: '首条用户文本' }, timestamp: '2026-10-01T00:00:00.000Z', sessionId: id },
      ]),
    );
    const sessions = await listClaudeSessions({ home: root });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]!.title, '压缩摘要标题');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('claude list: 只有元数据、没有对话行的会话跳过', async () => {
  const { root, dir } = makeProject();
  try {
    writeFileSync(
      join(dir, '55555555-5555-4555-8555-555555555555.jsonl'),
      jsonl([
        { type: 'mode', mode: 'normal' },
        { type: 'custom-title', customTitle: '只有标题' },
        { type: 'file-history-snapshot', messageId: 'x' },
        { type: 'user', isSidechain: true, message: { role: 'user', content: '子代理行' } },
      ]),
    );
    assert.deepEqual(await listClaudeSessions({ home: root }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
