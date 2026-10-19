import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { readKimiBundle } from '@sessionport/adapter-kimi-code';
import { writeClaudeSession } from '@sessionport/adapter-claude-code';
import { verifyClaudeSession } from '@sessionport/adapter-claude-code';

const BUNDLE = process.env.SESSIONPORT_KIMI_BUNDLE
  ? resolve(process.env.SESSIONPORT_KIMI_BUNDLE)
  : resolve(import.meta.dirname, '../../../session_fdefc84f-470a-421f-a62e-5ad404eceb82');
const hasBundle = existsSync(BUNDLE);
const skip = hasBundle ? false : '缺少本地真实 Kimi bundle（含隐私，未入库）';

test('端到端：真实 Kimi 会话 → IR → Claude JSONL → 结构自检', { skip }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sessionport-e2e-'));
  try {
    const bundle = await readKimiBundle(BUNDLE);
    const report = await writeClaudeSession(bundle, {
      configDir: dir,
      sessionId: '44444444-4444-4444-8444-444444444444',
      cwd: '/tmp/sessionport-e2e-project',
      version: '2.1.303',
    });

    assert.ok(report.rows.length > 20, 'rows=' + report.rows.length);

    const verify = await verifyClaudeSession({
      configDir: dir,
      cwd: '/tmp/sessionport-e2e-project',
      sessionId: '44444444-4444-4444-8444-444444444444',
    });
    assert.equal(verify.ok, true, JSON.stringify(verify.checks, null, 2));

    // 源会话的第一句用户消息必须原样出现在目标文件里
    const firstUser = bundle.root.events.find((e) => e.kind === 'message' && e.role === 'user' && !e.synthetic);
    assert.ok(firstUser && firstUser.kind === 'message');
    const expected = (firstUser.parts.find((p) => p.type === 'text') as { text: string }).text;
    const body = await readFile(report.filePath, 'utf8');
    const rows = body.trim().split('\n').map((l) => JSON.parse(l) as { type: string; message: { content: Array<{ text?: string }> } });
    const userTexts = rows
      .filter((r) => r.type === 'user')
      .flatMap((r) => r.message.content.map((b) => b.text ?? ''))
      .join('\n');
    assert.ok(userTexts.includes(expected), '第一句用户消息没有出现在目标会话里');

    // 每条工具调用都有结果（Claude 加载的硬要求）
    const assistantToolUses = rows
      .filter((r) => r.type === 'assistant')
      .flatMap((r) => r.message.content as Array<{ type?: string }>)
      .filter((b) => b.type === 'tool_use');
    assert.ok(assistantToolUses.length > 0);
    assert.equal(report.written.toolCalls, report.written.toolResults);

    // 损失清单必须非空且包含已知项
    assert.ok(report.losses.some((l) => l.code === 'claude.reasoning-dropped'));
    assert.ok(report.losses.some((l) => l.code === 'claude.subagent-dropped'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
