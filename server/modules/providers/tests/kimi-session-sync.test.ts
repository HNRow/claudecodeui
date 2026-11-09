import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { KimiSessionSynchronizer } from '@/modules/providers/list/kimi/kimi-session-synchronizer.provider.js';

const SESSION_ID = 'session_11111111-2222-3333-4444-555555555555';

type Fixture = {
  root: string;
  home: string;
  cleanup: () => Promise<void>;
  writeState: (options: {
    sessionId?: string;
    group?: string;
    state?: Record<string, unknown>;
    raw?: string;
    /** Wire contents; defaults to a session that already holds a user turn. */
    wire?: string;
  }) => Promise<string>;
};

/** Builds a Kimi home with one session directory and its metadata file. */
const createFixture = async (): Promise<Fixture> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kimi-sync-'));
  const home = path.join(root, 'kimi-home');

  return {
    root,
    home,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
    writeState: async ({ sessionId = SESSION_ID, group = 'wd_project_abc', state, raw, wire }) => {
      const sessionDirectory = path.join(home, 'sessions', group, sessionId);
      await mkdir(path.join(sessionDirectory, 'agents', 'main'), { recursive: true });
      await writeFile(
        path.join(sessionDirectory, 'agents', 'main', 'wire.jsonl'),
        wire ?? '{"type":"metadata"}\n{"type":"turn.prompt"}\n',
        'utf8',
      );
      const statePath = path.join(sessionDirectory, 'state.json');
      await writeFile(
        statePath,
        raw ?? JSON.stringify(state ?? {
          id: sessionId,
          cwd: '/tmp/kimi-project',
          title: 'Kimi test session',
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_060_000,
        }),
        'utf8',
      );
      return statePath;
    },
  };
};

async function withIsolatedDatabase(runTest: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'kimi-sync-db-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('the synchronizer indexes Kimi session metadata and its transcript path', { concurrency: false }, async () => {
  const fixture = await createFixture();
  const previousHome = process.env.KIMI_CODE_HOME;
  process.env.KIMI_CODE_HOME = fixture.home;
  try {
    await fixture.writeState({});

    await withIsolatedDatabase(async () => {
      const processed = await new KimiSessionSynchronizer().synchronize();
      assert.equal(processed, 1);

      const session = sessionsDb.getSessionByProviderSessionId(SESSION_ID);
      assert.ok(session);
      assert.equal(session.provider, 'kimi');
      assert.equal(session.custom_name, 'Kimi test session');
      assert.equal(session.project_path, '/tmp/kimi-project');
      assert.match(session.jsonl_path ?? '', /agents\/main\/wire\.jsonl$/);
    });
  } finally {
    if (previousHome === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = previousHome;
    await fixture.cleanup();
  }
});

test('malformed, archived, and non-state files are skipped without failing the scan', { concurrency: false }, async () => {
  const fixture = await createFixture();
  const previousHome = process.env.KIMI_CODE_HOME;
  process.env.KIMI_CODE_HOME = fixture.home;
  try {
    const brokenPath = await fixture.writeState({
      sessionId: 'session_broken-0000-0000-0000-000000000000',
      raw: '{"id":',
    });
    await fixture.writeState({
      sessionId: 'session_archived-0000-0000-0000-000000000000',
      state: {
        id: 'session_archived-0000-0000-0000-000000000000',
        cwd: '/tmp/kimi-project',
        archived: true,
      },
    });

    await withIsolatedDatabase(async () => {
      const synchronizer = new KimiSessionSynchronizer();
      assert.equal(await synchronizer.synchronize(), 0);
      assert.equal(await synchronizer.synchronizeFile(brokenPath), null);
      assert.equal(await synchronizer.synchronizeFile('/tmp/not-a-kimi-session/other.json'), null);
    });
  } finally {
    if (previousHome === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = previousHome;
    await fixture.cleanup();
  }
});

test('sessions without a user turn are not indexed', { concurrency: false }, async () => {
  const fixture = await createFixture();
  const previousHome = process.env.KIMI_CODE_HOME;
  process.env.KIMI_CODE_HOME = fixture.home;
  try {
    // Kimi writes the directory as soon as the CLI starts; only metadata and
    // profile events exist until a prompt is sent.
    const statePath = await fixture.writeState({
      wire: '{"type":"metadata"}\n{"type":"profile.bind"}\n',
    });

    await withIsolatedDatabase(async () => {
      const synchronizer = new KimiSessionSynchronizer();
      assert.equal(await synchronizer.synchronize(), 0);
      assert.equal(await synchronizer.synchronizeFile(statePath), null);
      assert.equal(sessionsDb.getSessionByProviderSessionId(SESSION_ID), null);
    });
  } finally {
    if (previousHome === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = previousHome;
    await fixture.cleanup();
  }
});

test('synchronizeFile upserts one session and returns the stored row id', { concurrency: false }, async () => {
  const fixture = await createFixture();
  const previousHome = process.env.KIMI_CODE_HOME;
  process.env.KIMI_CODE_HOME = fixture.home;
  try {
    const statePath = await fixture.writeState({});

    await withIsolatedDatabase(async () => {
      const storedId = await new KimiSessionSynchronizer().synchronizeFile(statePath);
      assert.ok(storedId);
      assert.equal(sessionsDb.getSessionByProviderSessionId(SESSION_ID)?.session_id, storedId);
    });
  } finally {
    if (previousHome === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = previousHome;
    await fixture.cleanup();
  }
});