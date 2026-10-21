import assert from 'node:assert/strict';
import { test } from 'node:test';

import { enLossMessages, enNoticeMessages } from '../src/renderer/src/i18n/dataMessages.ts';
import { enUS, hasMessage, interpolate, messageKeys, translate, zhCN } from '../src/renderer/src/i18n/messages.ts';

const CJK = /[\u3400-\u9fff]/u;

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? '').sort();
}

test('i18n：zh-CN 与 en-US 的 key 完全一致', () => {
  const zhKeys = Object.keys(zhCN).sort();
  const enKeys = Object.keys(enUS).sort();
  assert.deepEqual(enKeys, zhKeys, 'en-US 缺少或多出 key');
  assert.deepEqual(messageKeys().sort(), zhKeys);
  assert.ok(zhKeys.length > 100, '字典 key 数量应覆盖整个界面');
});

test('i18n：每个 key 的插值占位符一致', () => {
  for (const key of Object.keys(zhCN) as Array<keyof typeof zhCN>) {
    assert.deepEqual(placeholders(enUS[key]), placeholders(zhCN[key]), key);
  }
});

test('i18n：英文 UI 文案不残留中文（语言名本身除外）', () => {
  for (const [key, value] of Object.entries(enUS)) {
    if (key === 'settings.language.zh') continue;
    assert.ok(!CJK.test(value), key + ' 仍包含中文: ' + value);
  }
  for (const [code, value] of Object.entries(enLossMessages)) {
    assert.ok(!CJK.test(value), 'loss ' + code + ' 仍包含中文');
  }
  for (const [code, value] of Object.entries(enNoticeMessages)) {
    assert.ok(!CJK.test(value), 'notice ' + code + ' 仍包含中文');
  }
});

test('i18n：translate / interpolate 基础行为', () => {
  assert.equal(translate('zh-CN', 'sessions.subtitle', { sessions: 3, agents: 2 }), '3 个会话 · 2 个 agent');
  assert.equal(translate('en-US', 'sessions.subtitle', { sessions: 3, agents: 2 }), 'Sessions: 3 · Agents: 2');
  assert.equal(translate('en-US', 'theme.title', { mode: 'Dark' }), 'Theme: Dark');
  assert.equal(interpolate('hello {name}', { name: 'A' }), 'hello A');
  assert.equal(interpolate('hello {name}'), 'hello {name}');
  assert.ok(hasMessage('error.path.notFound'));
  assert.equal(hasMessage('error.not.a.real.code'), false);
});
