import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { listBusyKimiCliSessions } from '@/modules/providers/services/kimi-cli-liveness.service.js';

const SESSION_ID = 'session_00000000-0000-4000-8000-000000000001';
const LOCK_STARTED_AT = 1_700_000_000_000;
const TURN_STARTED_AT = 1_700_000_000_100;
const STARTED = JSON.stringify({ type: 'agent.turn.started', time: TURN_STARTED_AT });
const ENDED = JSON.stringify({ type: 'agent.turn.ended', time: TURN_STARTED_AT + 100 });

type FixtureContext = {
  lockPath: string;
  wirePath: string;
};

/** Runs one test against an isolated Kimi lock and main-agent wire fixture. */
async function withKimiFixture(
  runTest: (context: FixtureContext) => Promise<void>,
  options: { pid?: number; wireLines?: string[] } = {},
): Promise<void> {
  const previousHome = process.env.KIMI_CODE_HOME;
  const home = await mkdtemp(path.join(os.tmpdir(), 'kimi-cli-liveness-'));
  const lockDirectory = path.join(home, 'locks', 'sessions');
  const agentDirectory = path.join(home, 'sessions', 'workspace', SESSION_ID, 'agents', 'main');
  const lockPath = path.join(lockDirectory, `${SESSION_ID}.lock`);
  const wirePath = path.join(agentDirectory, 'wire.jsonl');
  await mkdir(lockDirectory, { recursive: true });
  await mkdir(agentDirectory, { recursive: true });
  await writeFile(lockPath, JSON.stringify({
    pid: options.pid ?? process.pid,
    startedAt: LOCK_STARTED_AT,
    clientIdentity: 'kimi_code_cli',
  }));
  await writeFile(wirePath, `${(options.wireLines ?? [STARTED]).join('\n')}\n`);
  process.env.KIMI_CODE_HOME = home;

  try {
    await runTest({ lockPath, wirePath });
  } finally {
    if (previousHome === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
}

test('a live lock and unfinished main-agent turn are busy', { concurrency: false }, async () => {
  await withKimiFixture(async () => {
    assert.deepEqual(await listBusyKimiCliSessions(), [{
      providerSessionId: SESSION_ID,
      startedAt: TURN_STARTED_AT,
    }]);
  });
});

test('a completed turn is idle and changed wire content invalidates cached state', { concurrency: false }, async () => {
  await withKimiFixture(async ({ wirePath }) => {
    assert.equal((await listBusyKimiCliSessions()).length, 1);
    assert.equal((await listBusyKimiCliSessions()).length, 1);
    await appendFile(wirePath, `${ENDED}\n`);
    assert.deepEqual(await listBusyKimiCliSessions(), []);
    assert.deepEqual(await listBusyKimiCliSessions(), []);
  });
});

test('an unfinished turn with a dead lock PID is stale', { concurrency: false }, async () => {
  await withKimiFixture(async () => {
    assert.deepEqual(await listBusyKimiCliSessions(), []);
  }, { pid: 4_194_302 });
});

test('malformed or incomplete lock and wire data is ignored', { concurrency: false }, async () => {
  await withKimiFixture(async ({ lockPath, wirePath }) => {
    await writeFile(lockPath, '{not json');
    await writeFile(wirePath, '{not json\n');
    assert.deepEqual(await listBusyKimiCliSessions(), []);

    await writeFile(lockPath, JSON.stringify({ pid: process.pid, startedAt: LOCK_STARTED_AT }));
    await writeFile(path.join(path.dirname(lockPath), 'not-a-kimi-session.lock'), JSON.stringify({ pid: process.pid }));
    await rm(wirePath);
    assert.deepEqual(await listBusyKimiCliSessions(), []);
  });
});

test('a started record without a timestamp falls back to the lock start time', { concurrency: false }, async () => {
  await withKimiFixture(async () => {
    assert.deepEqual(await listBusyKimiCliSessions(), [{
      providerSessionId: SESSION_ID,
      startedAt: LOCK_STARTED_AT,
    }]);
  }, { wireLines: [JSON.stringify({ type: 'agent.turn.started' })] });
});
