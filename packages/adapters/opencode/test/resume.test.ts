import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IR_VERSION } from '@sessionport/core';
import type { IrBundle, IrEvent, IrEventDraft } from '@sessionport/core';
import { resumeSmokeOpencode, writeOpencodeSession } from '../src/index.ts';

const RUN = process.env.SESSIONPORT_OPENCODE_RESUME === '1';
const REAL_DB = join(process.env.HOME ?? '', '.local', 'share', 'opencode', 'opencode.db');
const MODEL = process.env.SESSIONPORT_OPENCODE_MODEL ?? 'opencode-go/glm-5.2';

function chain(events: Array<IrEventDraft>): IrEvent[] {
  return events.map((event, index) => ({ ...event, parentId: index === 0 ? null : (events[index - 1] as { id: string }).id })) as IrEvent[];
}

test('无头 resume 冒烟：opencode run --session <导入的会话>', {
  skip: RUN ? false : '需要真实 provider 凭证，设置 SESSIONPORT_OPENCODE_RESUME=1 开启',
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sessionport-opencode-resume-'));
  try {
    // 隔离：复制真实库（凭证在库里），导入后 run --session
    const db = join(dir, 'opencode.db');
    copyFileSync(REAL_DB, db);
    const env = { OPENCODE_DB: db };
    const events = chain([
      { kind: 'message', id: 'e1', at: '2026-01-01T00:00:00Z', role: 'user', parts: [{ type: 'text', text: '记住暗号 BLUE-OTTER-42，只回复收到。' }] },
      { kind: 'message', id: 'e2', at: '2026-01-01T00:00:01Z', role: 'assistant', parts: [{ type: 'text', text: '收到。' }] },
    ] as Array<IrEventDraft>);
    const bundle: IrBundle = {
      irVersion: IR_VERSION,
      createdAt: '2026-01-01T00:00:00Z',
      root: {
        id: 'ir_oc_resume',
        source: { agent: 'kimi-code' },
        meta: { cwd: process.cwd(), title: 'opencode resume smoke' },
        events,
        head: events[events.length - 1]!.id,
        notices: [],
      },
      children: [],
    };
    const report = await writeOpencodeSession(bundle, {
      cwd: process.cwd(),
      id: 'ses_00000000000000000000r001',
      env,
      model: MODEL.split('/')[1],
      provider: MODEL.split('/')[0],
    });
    assert.equal(report.imported, true);
    const smoke = await resumeSmokeOpencode({ sessionId: report.sessionId, model: MODEL, env, cwd: process.cwd() });
    assert.equal(smoke.ok, true, smoke.stderr || smoke.stdout);
    assert.match(smoke.stdout, /BLUE-OTTER-42/);
    void existsSync;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
