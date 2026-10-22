import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IR_VERSION } from '@sessionport/core';
import type { IrBundle, IrEvent, IrEventDraft } from '@sessionport/core';
import { resumeSmokeCodex, writeCodexSession } from '../src/index.ts';

const RUN = process.env.SESSIONPORT_CODEX_RESUME === '1';
const REAL_HOME = process.env.CODEX_HOME ?? join(process.env.HOME ?? '', '.codex');

function chain(events: Array<IrEventDraft>): IrEvent[] {
  return events.map((event, index) => ({ ...event, parentId: index === 0 ? null : (events[index - 1] as { id: string }).id })) as IrEvent[];
}

test('无头 resume 冒烟：codex exec resume <生成的 rollout>', { skip: RUN ? false : '需要真实模型调用，设置 SESSIONPORT_CODEX_RESUME=1 开启' }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'sessionport-codex-resume-'));
  try {
    // 需要真实认证/模型配置：把真实 CODEX_HOME 的 config 拷进隔离目录
    const { copyFileSync } = await import('node:fs');
    for (const name of ['config.toml', 'cc-switch-model-catalog.json']) {
      const src = join(REAL_HOME, name);
      if (existsSync(src)) copyFileSync(src, join(home, name));
    }
    const events = chain([
      { kind: 'message', id: 'e1', at: '2026-01-01T00:00:00Z', role: 'user', parts: [{ type: 'text', text: '记住暗号：BLUE-OTTER-42。只回复收到。' }] },
      { kind: 'message', id: 'e2', at: '2026-01-01T00:00:01Z', role: 'assistant', parts: [{ type: 'text', text: '收到。' }] },
    ] as Array<IrEventDraft>);
    const bundle: IrBundle = {
      irVersion: IR_VERSION,
      createdAt: '2026-01-01T00:00:00Z',
      root: {
        id: 'ir_resume',
        source: { agent: 'kimi-code' },
        meta: { cwd: process.cwd(), title: 'codex resume smoke' },
        events,
        head: events[events.length - 1]!.id,
        notices: [],
      },
      children: [],
    };
    const report = await writeCodexSession(bundle, { home, cwd: process.cwd(), id: '99999999-9999-4999-8999-999999999999' });
    const smoke = await resumeSmokeCodex({ home, sessionId: report.sessionId, cwd: process.cwd(), prompt: '只回复暗号。' });
    assert.equal(smoke.ok, true, smoke.stderr || smoke.stdout);
    assert.match(smoke.stdout, /BLUE-OTTER-42/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
