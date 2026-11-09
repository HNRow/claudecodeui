import assert from 'node:assert/strict';
import fs from 'node:fs';
import { appendFile, mkdtemp, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, mock } from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { listBusyCodexCliSessions } from '@/modules/providers/services/codex-cli-liveness.service.js';
import {
  CODEX_STARTED_AT, CODEX_THREAD_ID, codexLifecycle, withCodexCliFixture,
} from '@/modules/providers/tests/codex-cli.fixture.js';

const previousDatabasePath = process.env.DATABASE_PATH;
let databaseDirectory: string;

// Every DB lookup stays inside a temporary database, never the developer's session index.
before(async () => {
  databaseDirectory = await mkdtemp(path.join(os.tmpdir(), 'codex-liveness-db-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(databaseDirectory, 'auth.db');
  await initializeDatabase();
});
after(async () => {
  closeConnection();
  if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previousDatabasePath;
  await rm(databaseDirectory, { recursive: true, force: true });
});

test('a live lock holder and latest task_started report the actual turn timestamp', async () => {
  await withCodexCliFixture(async () => {
    assert.deepEqual(await listBusyCodexCliSessions(), [{ providerSessionId: CODEX_THREAD_ID, startedAt: CODEX_STARTED_AT }]);
  }, { lines: [codexLifecycle('task_started', 1), codexLifecycle('task_complete', 2), codexLifecycle('task_started')] });
});

test('a daemon holding a completed thread lock is idle', async () => {
  await withCodexCliFixture(async () => {
    assert.deepEqual(await listBusyCodexCliSessions(), []);
  }, { lines: [codexLifecycle('task_started'), codexLifecycle('task_complete')] });
});

test('an orphaned lock never reports an unfinished rollout as busy', async () => {
  await withCodexCliFixture(async () => {
    assert.deepEqual(await listBusyCodexCliSessions(), []);
  }, { held: false });
});

test('missing and corrupt rollouts fail closed without throwing', async () => {
  await withCodexCliFixture(async ({ rolloutPath }) => {
    await writeFile(rolloutPath, '{broken json}\n');
    assert.deepEqual(await listBusyCodexCliSessions(), []);
    await writeFile(rolloutPath, `${codexLifecycle('task_started')}\n{broken json}\n`);
    assert.deepEqual(await listBusyCodexCliSessions(), []);
    await rm(rolloutPath);
    assert.deepEqual(await listBusyCodexCliSessions(), []);
  });
});

test('unchanged rollouts use cached parsing while lock holders are rechecked every poll', async () => {
  await withCodexCliFixture(async ({ rolloutPath, stopHolder }) => {
    const realCreateReadStream = fs.createReadStream;
    let reads = 0;
    const reader = mock.method(fs, 'createReadStream', (file: Parameters<typeof fs.createReadStream>[0], options: Parameters<typeof fs.createReadStream>[1]) => {
      if (file === rolloutPath) reads += 1;
      return realCreateReadStream(file, options);
    });
    try {
      assert.equal((await listBusyCodexCliSessions()).length, 1);
      assert.equal((await listBusyCodexCliSessions()).length, 1);
      assert.equal(reads, 1, 'the same rollout is streamed only once');
      await stopHolder();
      assert.deepEqual(await listBusyCodexCliSessions(), []);
    } finally {
      reader.mock.restore();
    }
  });
});

test('appended completion invalidates cached busy state and parses the suffix after prefix validation', async () => {
  await withCodexCliFixture(async ({ rolloutPath }) => {
    assert.equal((await listBusyCodexCliSessions()).length, 1);
    const previousSize = (await stat(rolloutPath)).size;
    const reader = mock.method(fs, 'createReadStream');
    try {
      await appendFile(rolloutPath, `${codexLifecycle('task_complete')}\n`);
      assert.deepEqual(await listBusyCodexCliSessions(), []);
      const options = reader.mock.calls.at(-1)?.arguments[1];
      assert.equal(typeof options === 'object' ? options.start : undefined, previousSize);
    } finally {
      reader.mock.restore();
    }
  });
});

test('truncation and same-size rewrites invalidate the parsed state', async () => {
  await withCodexCliFixture(async ({ rolloutPath }) => {
    assert.equal((await listBusyCodexCliSessions()).length, 1);
    await writeFile(rolloutPath, `${codexLifecycle('task_complete')}\n`);
    assert.deepEqual(await listBusyCodexCliSessions(), []);
    const busy = `${codexLifecycle('task_started')}\n`;
    await writeFile(rolloutPath, busy);
    assert.equal((await listBusyCodexCliSessions()).length, 1);
    await writeFile(rolloutPath, ' '.repeat(Buffer.byteLength(busy)));
    await utimes(rolloutPath, new Date(), new Date(Date.now() + 2000));
    assert.deepEqual(await listBusyCodexCliSessions(), []);
  });
});

test('an incomplete lifecycle row fails closed until the append finishes', async () => {
  await withCodexCliFixture(async ({ rolloutPath }) => {
    assert.equal((await listBusyCodexCliSessions()).length, 1);
    const complete = codexLifecycle('task_complete');
    await appendFile(rolloutPath, complete.slice(0, 25));
    assert.deepEqual(await listBusyCodexCliSessions(), []);
    await appendFile(rolloutPath, `${complete.slice(25)}\n`);
    assert.deepEqual(await listBusyCodexCliSessions(), []);
  });
});

test('a growing rewrite before an unchanged tail cannot retain cached busy state', async () => {
  await withCodexCliFixture(async ({ rolloutPath }) => {
    const tail = `${JSON.stringify({ type: 'response_item', payload: { text: 'x'.repeat(6000) } })}\n`;
    await writeFile(rolloutPath, `${codexLifecycle('task_started')} \n${tail}`);
    assert.equal((await listBusyCodexCliSessions()).length, 1);
    await writeFile(rolloutPath, `${codexLifecycle('task_complete')}\n${tail}${JSON.stringify({ type: 'event_msg', payload: { type: 'token_count' } })}\n`);
    assert.deepEqual(await listBusyCodexCliSessions(), []);
  });
});

test('a stale lock alongside a held lock does not hide the live session', async () => {
  await withCodexCliFixture(async ({ lockPath }) => {
    await writeFile(path.join(path.dirname(lockPath), '00000000-0000-0000-0000-000000000000.lock'), '');
    assert.equal((await listBusyCodexCliSessions()).length, 1);
  });
});

test('a missing timestamp falls back to the lock mtime', async () => {
  await withCodexCliFixture(async ({ lockPath }) => {
    const lockTime = (await stat(lockPath)).mtimeMs;
    assert.deepEqual(await listBusyCodexCliSessions(), [{ providerSessionId: CODEX_THREAD_ID, startedAt: lockTime }]);
  }, { lines: [JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } })] });
});

test('indexed jsonl_path takes precedence over a different fallback rollout', async () => {
  await withCodexCliFixture(async ({ home }) => {
    const indexedPath = path.join(home, 'indexed.jsonl');
    await writeFile(indexedPath, `${codexLifecycle('task_complete')}\n`);
    sessionsDb.createSession(CODEX_THREAD_ID, 'codex', '/tmp/codex-test', 'Indexed', undefined, undefined, indexedPath);
    try {
      assert.deepEqual(await listBusyCodexCliSessions(), []);
    } finally {
      sessionsDb.deleteSessionById(CODEX_THREAD_ID);
    }
  });
});

test('unavailable lsof fails closed and invalid lock names or symlinks are ignored', async () => {
  await withCodexCliFixture(async ({ home, lockPath }) => {
    // Absolute discovery would still find the real lsof, so force a missing
    // binary explicitly instead of relying on a stripped PATH.
    const previousLsof = process.env.CODEX_LSOF_PATH;
    process.env.CODEX_LSOF_PATH = path.join(home, 'missing-lsof');
    try {
      assert.deepEqual(await listBusyCodexCliSessions(), []);
    } finally {
      if (previousLsof === undefined) delete process.env.CODEX_LSOF_PATH;
      else process.env.CODEX_LSOF_PATH = previousLsof;
    }
    await writeFile(path.join(home, 'thread-writer-locks', 'bad-name.lock'), '');
    await rm(lockPath);
    await symlink(path.join(home, 'sessions'), lockPath);
    assert.deepEqual(await listBusyCodexCliSessions(), []);
  });
});
