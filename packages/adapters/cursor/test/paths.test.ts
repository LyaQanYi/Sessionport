import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  computeWorkspaceId,
  cursorGlobalDbPath,
  cursorUserDataDir,
  fsPathFromWorkspaceIdentifier,
  listCursorWorkspaces,
  resolveCursorPaths,
  resolveWorkspaceId,
  workspaceIdentifierFor,
} from '../src/index.ts';
import { createCursorFixture } from './helpers.ts';

test('workspace 目录解析：列表/复用/推导/URI 结构', () => {
  const fixture = createCursorFixture({ composers: [] });
  try {
    const workspaces = listCursorWorkspaces(fixture.home);
    assert.equal(workspaces.length, 1);
    assert.equal(workspaces[0]?.workspaceId, 'ws-test');
    assert.equal(workspaces[0]?.cwd, fixture.cwd);

    assert.equal(resolveWorkspaceId(fixture.home, fixture.cwd), 'ws-test');

    const other = join(fixture.home, 'another');
    mkdirSync(other, { recursive: true });
    const computed = computeWorkspaceId(other);
    assert.ok(computed !== undefined);
    assert.match(computed, /^[0-9a-f]{32}$/);
    assert.equal(resolveWorkspaceId(fixture.home, other), computed);
    assert.equal(computeWorkspaceId(join(fixture.home, 'missing-dir')), undefined);

    const identifier = workspaceIdentifierFor('ws-test', fixture.cwd);
    assert.equal(identifier.id, 'ws-test');
    assert.equal(identifier.uri.$mid, 1);
    assert.equal(identifier.uri.fsPath, fixture.cwd);
    assert.equal(identifier.uri.scheme, 'file');
    assert.equal(fsPathFromWorkspaceIdentifier(identifier), fixture.cwd);
    assert.equal(fsPathFromWorkspaceIdentifier({ uri: 'file://' + fixture.cwd }), fixture.cwd);
    assert.equal(fsPathFromWorkspaceIdentifier(undefined), undefined);
  } finally {
    fixture.cleanup();
  }
});

test('路径解析支持显式 home / dbPath 与 SESSIONPORT_CURSOR_HOME', () => {
  const fixture = createCursorFixture({ composers: [] });
  try {
    assert.equal(resolveCursorPaths({ home: fixture.home }).dbPath, fixture.dbPath);
    assert.equal(resolveCursorPaths({ home: fixture.home, dbPath: '/tmp/override.vscdb' }).dbPath, '/tmp/override.vscdb');
    assert.equal(cursorGlobalDbPath(fixture.home), fixture.dbPath);
    assert.equal(cursorUserDataDir(fixture.home), fixture.home);

    const previous = process.env.SESSIONPORT_CURSOR_HOME;
    process.env.SESSIONPORT_CURSOR_HOME = fixture.home;
    try {
      assert.equal(cursorUserDataDir(), fixture.home);
      assert.equal(resolveCursorPaths().dbPath, fixture.dbPath);
    } finally {
      if (previous === undefined) delete process.env.SESSIONPORT_CURSOR_HOME;
      else process.env.SESSIONPORT_CURSOR_HOME = previous;
    }

    const expanded = cursorUserDataDir('~/cursor-test-home');
    assert.ok(expanded.startsWith('/'));
    assert.ok(!expanded.startsWith('~'));
  } finally {
    fixture.cleanup();
  }
});
