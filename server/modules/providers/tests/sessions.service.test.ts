import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import { CODEX_STARTED_AT, CODEX_THREAD_ID, codexLifecycle, withCodexCliFixture } from '@/modules/providers/tests/codex-cli.fixture.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import type { IProvider } from '@/shared/interfaces.js';
import type { BackgroundTaskSummary } from '@/shared/types.js';

/** Runs service assertions against a temporary database without touching the user's index. */
async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'sessions-service-db-'));

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

test('provider session id returns the mapped native id', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-session-id', 'codex', '/tmp/session-id-copy-project');
    sessionsDb.assignProviderSessionId('app-session-id', 'codex-native-session-id');

    assert.equal(sessionsService.getProviderSessionId('app-session-id'), 'codex-native-session-id');
  });
});

test('app session names use at most four whole words from the initial message', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    const result = sessionsService.createAppSession(
      'codex',
      '/tmp/session-name-project',
      '  supercalifragilisticexpialidocious\nsecond   third fourth fifth  ',
    );

    assert.equal(result.sessionName, 'supercalifragilisticexpialidocious second third fourth');
    assert.equal(
      sessionsDb.getSessionById(result.sessionId)?.custom_name,
      'supercalifragilisticexpialidocious second third fourth',
    );
  });
});

test('app sessions without message text receive a stable fallback name', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    const result = sessionsService.createAppSession('claude', '/tmp/attachment-only-project', '  \n ');

    assert.equal(result.sessionName, 'Untitled Session');
    assert.equal(sessionsDb.getSessionById(result.sessionId)?.custom_name, 'Untitled Session');
  });
});

test('provider session id is unavailable until the provider assigns one', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('pending-app-session', 'claude', '/tmp/session-id-copy-project');

    assert.throws(
      () => sessionsService.getProviderSessionId('pending-app-session'),
      (error: unknown) => {
        const typedError = error as { code?: string; statusCode?: number };
        return typedError.code === 'PROVIDER_SESSION_ID_NOT_AVAILABLE' && typedError.statusCode === 409;
      },
    );
  });
});

test('provider session id reports a missing app session', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    assert.throws(
      () => sessionsService.getProviderSessionId('missing-session'),
      (error: unknown) => {
        const typedError = error as { code?: string; statusCode?: number };
        return typedError.code === 'SESSION_NOT_FOUND' && typedError.statusCode === 404;
      },
    );
  });
});

test('recent sessions map project metadata and preserve database pagination', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession(
      'older-session',
      'claude',
      '/tmp/recent-project',
      'Older conversation',
      '2026-08-01T08:00:00.000Z',
      '2026-08-01T09:00:00.000Z',
    );
    sessionsDb.createSession(
      'newer-session',
      'codex',
      '/tmp/recent-project',
      'Newer conversation',
      '2026-08-01T10:00:00.000Z',
      '2026-08-01T11:00:00.000Z',
    );
    projectsDb.updateCustomProjectName('/tmp/recent-project', 'Recent Project');

    const project = projectsDb.getProjectPath('/tmp/recent-project');
    const page = sessionsService.listRecentSessions(1, 0);

    assert.deepEqual(page, {
      conversations: [{
        sessionId: 'newer-session',
        provider: 'codex',
        projectId: project?.project_id ?? null,
        projectDisplayName: 'Recent Project',
        sessionTitle: 'Newer conversation',
        lastActivity: '2026-08-01T11:00:00.000Z',
      }],
      total: 2,
      hasMore: true,
    });
  });
});

/** One Claude transcript row of user or assistant text, linked by uuid chain. */
function claudeTextRow(
  sessionId: string,
  role: 'user' | 'assistant',
  text: string,
  ordinal: number,
): Record<string, unknown> {
  return {
    type: role,
    uuid: `row-${ordinal}`,
    parentUuid: ordinal === 0 ? null : `row-${ordinal - 1}`,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, ordinal)).toISOString(),
    sessionId,
    message: { role, content: [{ type: 'text', text }] },
  };
}

test('history pages are sliced from the cached full transcript and see appended rows', { concurrency: false }, async () => {
  const transcriptDirectory = await mkdtemp(path.join(os.tmpdir(), 'sessions-service-history-'));
  const sessionId = 'claude-history-cache-session';
  const transcriptPath = path.join(transcriptDirectory, `${sessionId}.jsonl`);

  try {
    await withIsolatedDatabase(async () => {
      const rows = [
        claudeTextRow(sessionId, 'user', 'one', 0),
        claudeTextRow(sessionId, 'assistant', 'reply one', 1),
        claudeTextRow(sessionId, 'user', 'two', 2),
        claudeTextRow(sessionId, 'assistant', 'reply two', 3),
      ];
      await writeFile(transcriptPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
      sessionsDb.createSession(
        sessionId,
        'claude',
        '/tmp/history-cache-project',
        'History cache conversation',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:10.000Z',
        transcriptPath,
      );

      const page = await sessionsService.fetchHistory(sessionId, { limit: 2, offset: 0 });
      assert.equal(page.total, 4);
      assert.equal(page.hasMore, true);
      assert.deepEqual(page.messages.map((message) => message.content), ['two', 'reply two']);

      // A row appended after the page was cached must appear on the next read.
      await appendFile(
        transcriptPath,
        `${JSON.stringify(claudeTextRow(sessionId, 'user', 'three', 4))}\n`,
        'utf8',
      );
      const refreshed = await sessionsService.fetchHistory(sessionId, { limit: 2, offset: 0 });
      assert.equal(refreshed.total, 5);
      assert.deepEqual(refreshed.messages.map((message) => message.content), ['reply two', 'three']);

      // An older page keeps the tail-offset contract while served from cache.
      const older = await sessionsService.fetchHistory(sessionId, { limit: 2, offset: 2 });
      assert.deepEqual(older.messages.map((message) => message.content), ['reply one', 'two']);
      assert.equal(older.hasMore, true);
    });
  } finally {
    await rm(transcriptDirectory, { recursive: true, force: true });
  }
});

/**
 * Stands in for the provider registry with one provider per id, each with the
 * runtime given — the seam through which a runtime's background work reaches
 * the running-sessions list without an SDK run behind it.
 */
async function withProviders(
  runtimes: Partial<Record<'claude' | 'codex' | 'kimi', IProvider['runtime']>>,
  runTest: () => void | Promise<void>,
): Promise<void> {
  const realListProviders = providerRegistry.listProviders;
  providerRegistry.listProviders = () =>
    Object.entries(runtimes).map(([id, runtime]) => ({ id, runtime }) as IProvider);
  try {
    await runTest();
  } finally {
    providerRegistry.listProviders = realListProviders;
    chatRunRegistry.clearAll();
  }
}

/**
 * Runs `runTest` against a Claude CLI process registry containing exactly
 * `records`, so the running-sessions tests never read the developer's real
 * `~/.claude/sessions`.
 */
async function withClaudeCliRegistry(
  records: Array<Record<string, unknown>>,
  runTest: () => void | Promise<void>,
): Promise<void> {
  const homeDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-cli-registry-'));
  await mkdir(path.join(homeDirectory, '.claude', 'sessions'), { recursive: true });
  for (const record of records) {
    await writeFile(
      path.join(homeDirectory, '.claude', 'sessions', `${record.pid}.json`),
      JSON.stringify(record),
      'utf8',
    );
  }

  const realHomedir = os.homedir;
  (os as unknown as { homedir: () => string }).homedir = () => homeDirectory;
  try {
    await runTest();
  } finally {
    (os as unknown as { homedir: () => string }).homedir = realHomedir;
    await rm(homeDirectory, { recursive: true, force: true });
  }
}

const KIMI_CLI_SESSION_ID = 'session_00000000-0000-4000-8000-000000000001';

/** Runs one service test with an isolated external Kimi session in the requested turn state. */
async function withKimiCliSession(
  turnType: 'agent.turn.started' | 'agent.turn.ended',
  runTest: () => void | Promise<void>,
): Promise<void> {
  const previousHome = process.env.KIMI_CODE_HOME;
  const homeDirectory = await mkdtemp(path.join(os.tmpdir(), 'kimi-cli-liveness-'));
  const lockDirectory = path.join(homeDirectory, 'locks', 'sessions');
  const agentDirectory = path.join(
    homeDirectory, 'sessions', 'workspace', KIMI_CLI_SESSION_ID, 'agents', 'main',
  );
  await mkdir(lockDirectory, { recursive: true });
  await mkdir(agentDirectory, { recursive: true });
  await writeFile(
    path.join(lockDirectory, `${KIMI_CLI_SESSION_ID}.lock`),
    JSON.stringify({ pid: process.pid, startedAt: 3_000, clientIdentity: 'kimi_code_cli' }),
  );
  await writeFile(
    path.join(agentDirectory, 'wire.jsonl'),
    `${JSON.stringify({ type: turnType, time: 4_000 })}\n`,
  );
  process.env.KIMI_CODE_HOME = homeDirectory;
  try {
    await runTest();
  } finally {
    if (previousHome === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = previousHome;
    await rm(homeDirectory, { recursive: true, force: true });
  }
}

const task = (taskId: string, startedAt: number): BackgroundTaskSummary => ({
  taskId,
  toolUseId: `toolu_${taskId}`,
  taskType: 'local_agent',
  description: `Task ${taskId}`,
  startedAt,
});

test('running sessions list a session whose background work outlived its turn', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('held-session', 'claude', '/tmp/running-project');
    // The turn ran and completed: the registry still holds the finished run.
    const run = chatRunRegistry.startRun({
      appSessionId: 'held-session', provider: 'claude', providerSessionId: null, connection: null, userId: null,
    });
    assert.ok(run);
    run.writer.send({ kind: 'text', content: 'launched', sessionId: 'held-session', provider: 'claude' });
    run.writer.sendComplete({ exitCode: 0 });
    assert.equal(run.status, 'completed');

    const tasks = [task('late', 2_000), task('early', 1_000)];
    await withClaudeCliRegistry([], async () => await withProviders(
      { claude: { run: async () => undefined, abort: () => false, listBackgroundWork: () => [{ sessionId: 'held-session', tasks }] } },
      async () => {
        assert.deepEqual(await sessionsService.listRunningSessions(), [{
          sessionId: 'held-session',
          provider: 'claude',
          startedAt: 1_000,
          lastSeq: run.lastSeq,
          background: true,
          canInterrupt: false,
          tasks,
        }]);
        assert.ok(run.lastSeq > 0, 'the finished run still reports its sequence for replay');
      },
    ));
  });
});

test('running sessions carry their tasks on a chat run that is still going', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('busy-session', 'claude', '/tmp/running-project');
    sessionsDb.createAppSession('idle-session', 'codex', '/tmp/running-project');
    const run = chatRunRegistry.startRun({
      appSessionId: 'busy-session', provider: 'claude', providerSessionId: null, connection: null, userId: null,
    });
    assert.ok(run);

    const tasks = [task('agent', 5_000)];
    await withClaudeCliRegistry([], async () => await withProviders(
      {
        claude: { run: async () => undefined, abort: () => false, listBackgroundWork: () => [{ sessionId: 'busy-session', tasks }] },
        // A runtime without background work contributes chat runs alone.
        codex: { run: async () => undefined, abort: () => false },
      },
      async () => {
        const sessions = await sessionsService.listRunningSessions();
        assert.equal(sessions.length, 1, 'a session with a running chat run is listed once');
        assert.deepEqual(sessions[0], {
          sessionId: 'busy-session',
          provider: 'claude',
          startedAt: run.startedAt,
          lastSeq: 0,
          tasks,
        });
      },
    ));
  });
});

test('running sessions with no background work are the chat runs alone', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('plain-session', 'codex', '/tmp/running-project');
    const run = chatRunRegistry.startRun({
      appSessionId: 'plain-session', provider: 'codex', providerSessionId: null, connection: null, userId: null,
    });
    assert.ok(run);

    await withClaudeCliRegistry([], async () => await withProviders(
      { codex: { run: async () => undefined, abort: () => false } },
      async () => {
        assert.deepEqual(await sessionsService.listRunningSessions(), [{
          sessionId: 'plain-session', provider: 'codex', startedAt: run.startedAt, lastSeq: 0,
        }]);
      },
    ));
  });
});

test('running sessions report a turn driven by the Kimi CLI', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('kimi-cli-app', 'kimi', '/tmp/running-project');
    sessionsDb.assignProviderSessionId('kimi-cli-app', KIMI_CLI_SESSION_ID);

    await withKimiCliSession('agent.turn.started', async () => await withClaudeCliRegistry([], async () => await withProviders(
      { kimi: { run: async () => undefined, abort: () => false } },
      async () => {
        assert.deepEqual(await sessionsService.listRunningSessions(), [{
          sessionId: 'kimi-cli-app',
          provider: 'kimi',
          startedAt: 4_000,
          lastSeq: 0,
          canInterrupt: false,
          statusText: 'Running in the Kimi CLI',
        }]);
      },
    )));
  });
});

test('external Codex sessions map native thread ids to app ids with replay sequence', async () => {
  await withIsolatedDatabase(async () => await withCodexCliFixture(async () => {
    sessionsDb.createAppSession('codex-cli-app', 'codex', '/tmp/running-project');
    sessionsDb.assignProviderSessionId('codex-cli-app', CODEX_THREAD_ID);
    const run = chatRunRegistry.startRun({
      appSessionId: 'codex-cli-app', provider: 'codex', providerSessionId: CODEX_THREAD_ID,
      connection: null, userId: null,
    });
    assert.ok(run);
    run.writer.sendComplete({ exitCode: 0 });
    await withClaudeCliRegistry([], async () => await withProviders({}, async () => {
      assert.deepEqual(await sessionsService.listRunningSessions(), [{
        sessionId: 'codex-cli-app', provider: 'codex', startedAt: CODEX_STARTED_AT,
        lastSeq: run.lastSeq, canInterrupt: false, statusText: 'Running in the Codex CLI',
      }]);
    }));
  }));
});

test('external Codex detection preserves the CloudCLI run and its tasks', async () => {
  await withIsolatedDatabase(async () => await withCodexCliFixture(async () => {
    sessionsDb.createAppSession('codex-owned', 'codex', '/tmp/running-project');
    sessionsDb.assignProviderSessionId('codex-owned', CODEX_THREAD_ID);
    const run = chatRunRegistry.startRun({
      appSessionId: 'codex-owned', provider: 'codex', providerSessionId: CODEX_THREAD_ID,
      connection: null, userId: null,
    });
    assert.ok(run);
    const tasks = [task('codex-task', 1000)];
    await withClaudeCliRegistry([], async () => await withProviders({
      codex: { run: async () => undefined, abort: () => false, listBackgroundWork: () => [{ sessionId: 'codex-owned', tasks }] },
    }, async () => {
      assert.deepEqual(await sessionsService.listRunningSessions(), [{
        sessionId: 'codex-owned', provider: 'codex', startedAt: run.startedAt, lastSeq: run.lastSeq, tasks,
      }]);
    }));
  }));
});

test('external Codex detection preserves standalone background work without duplicates', async () => {
  await withIsolatedDatabase(async () => await withCodexCliFixture(async () => {
    sessionsDb.createAppSession('codex-background', 'codex', '/tmp/running-project');
    sessionsDb.assignProviderSessionId('codex-background', CODEX_THREAD_ID);
    const tasks = [task('codex-background-task', 2000)];
    await withClaudeCliRegistry([], async () => await withProviders({
      codex: { run: async () => undefined, abort: () => false, listBackgroundWork: () => [{ sessionId: 'codex-background', tasks }] },
    }, async () => {
      assert.deepEqual(await sessionsService.listRunningSessions(), [{
        sessionId: 'codex-background', provider: 'codex', startedAt: 2000, lastSeq: 0,
        background: true, canInterrupt: false, tasks,
      }]);
    }));
  }));
});

test('unindexed and completed external Codex sessions leave other provider runs intact', async () => {
  await withIsolatedDatabase(async () => await withCodexCliFixture(async ({ rolloutPath }) => {
    await withClaudeCliRegistry([], async () => await withProviders({}, async () => {
      const run = chatRunRegistry.startRun({
        appSessionId: 'other-claude', provider: 'claude', providerSessionId: null,
        connection: null, userId: null,
      });
      assert.ok(run);
      assert.deepEqual((await sessionsService.listRunningSessions()).map((entry) => entry.sessionId), ['other-claude']);
      sessionsDb.createAppSession('codex-finished', 'codex', '/tmp/running-project');
      sessionsDb.assignProviderSessionId('codex-finished', CODEX_THREAD_ID);
      await appendFile(rolloutPath, `${codexLifecycle('task_complete')}\n`);
      assert.deepEqual((await sessionsService.listRunningSessions()).map((entry) => entry.sessionId), ['other-claude']);
    }));
  }));
});

test('an external Kimi turn does not duplicate a CloudCLI-owned run', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('kimi-both', 'kimi', '/tmp/running-project');
    sessionsDb.assignProviderSessionId('kimi-both', KIMI_CLI_SESSION_ID);
    const run = chatRunRegistry.startRun({
      appSessionId: 'kimi-both', provider: 'kimi', providerSessionId: KIMI_CLI_SESSION_ID,
      connection: null, userId: null,
    });
    assert.ok(run);

    await withKimiCliSession('agent.turn.started', async () => await withClaudeCliRegistry([], async () => await withProviders(
      { kimi: { run: async () => undefined, abort: () => false } },
      async () => {
        assert.deepEqual(await sessionsService.listRunningSessions(), [{
          sessionId: 'kimi-both', provider: 'kimi', startedAt: run.startedAt, lastSeq: 0,
        }]);
      },
    )));
  });
});

test('a completed external Kimi turn is not listed as running', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('kimi-idle', 'kimi', '/tmp/running-project');
    sessionsDb.assignProviderSessionId('kimi-idle', KIMI_CLI_SESSION_ID);

    await withKimiCliSession('agent.turn.ended', async () => await withClaudeCliRegistry([], async () => await withProviders(
      { kimi: { run: async () => undefined, abort: () => false } },
      async () => {
        assert.deepEqual(await sessionsService.listRunningSessions(), []);
      },
    )));
  });
});

test('running sessions report a turn driven by the Claude CLI', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('cli-session', 'claude', '/tmp/running-project');
    sessionsDb.assignProviderSessionId('cli-session', 'claude-native-1');

    // `process.pid` is the one pid guaranteed to be alive; omitting procStart
    // keeps the fixture portable, since the start-time cross-check is Linux-only.
    await withClaudeCliRegistry(
      [{ pid: process.pid, sessionId: 'claude-native-1', status: 'busy', entrypoint: 'cli', startedAt: 4_000 }],
      async () => await withProviders(
        { claude: { run: async () => undefined, abort: () => false } },
        async () => {
          assert.deepEqual(await sessionsService.listRunningSessions(), [{
            sessionId: 'cli-session',
            provider: 'claude',
            startedAt: 4_000,
            lastSeq: 0,
            canInterrupt: false,
            statusText: 'Running in the Claude CLI',
          }]);
        },
      ),
    );
  });
});

test('running sessions ignore registry files a crash left behind', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('stale-session', 'claude', '/tmp/running-project');
    sessionsDb.assignProviderSessionId('stale-session', 'claude-native-stale');

    await withClaudeCliRegistry(
      [
        // The process is gone: signal 0 cannot find this pid.
        { pid: 4_194_302, sessionId: 'claude-native-stale', status: 'busy', startedAt: 1_000 },
        // Alive, but waiting for input rather than producing a response.
        { pid: process.pid, sessionId: 'claude-native-idle', status: 'idle', startedAt: 2_000 },
      ],
      async () => await withProviders(
        { claude: { run: async () => undefined, abort: () => false } },
        async () => {
          assert.deepEqual(await sessionsService.listRunningSessions(), []);
        },
      ),
    );
  });
});

test('a CLI turn does not duplicate a session already running a chat run', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('both-session', 'claude', '/tmp/running-project');
    sessionsDb.assignProviderSessionId('both-session', 'claude-native-both');
    const run = chatRunRegistry.startRun({
      appSessionId: 'both-session', provider: 'claude', providerSessionId: 'claude-native-both', connection: null, userId: null,
    });
    assert.ok(run);

    await withClaudeCliRegistry(
      [{ pid: process.pid, sessionId: 'claude-native-both', status: 'busy', startedAt: 3_000 }],
      async () => await withProviders(
        { claude: { run: async () => undefined, abort: () => false } },
        async () => {
          const sessions = await sessionsService.listRunningSessions();
          assert.equal(sessions.length, 1, 'the chat run already covers this session');
          assert.equal(sessions[0].canInterrupt, undefined, 'the interruptible chat run entry wins');
        },
      ),
    );
  });
});

test('an unreadable registry never fails the running-sessions poll', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('safe-session', 'claude', '/tmp/running-project');
    sessionsDb.assignProviderSessionId('safe-session', 'claude-native-safe');

    await withClaudeCliRegistry(
      [{ pid: process.pid, sessionId: 'claude-native-safe', status: 'busy', startedAt: 5_000 }],
      async () => {
        // A half-written file sits alongside the good one; it must be skipped
        // rather than abort the whole poll.
        await writeFile(path.join(os.homedir(), '.claude', 'sessions', 'broken.json'), '{"pid":', 'utf8');
        await withProviders(
          { claude: { run: async () => undefined, abort: () => false } },
          async () => {
            const sessions = await sessionsService.listRunningSessions();
            assert.deepEqual(sessions.map((session) => session.sessionId), ['safe-session']);
          },
        );
      },
    );
  });
});
