import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const CODEX_THREAD_ID = '01a1b132-6463-79c3-bad1-cfc6ffb7002a';
export const CODEX_STARTED_AT = 1_700_000_000_100;

/** Builds a real Codex lifecycle row without depending on production parsing. */
export function codexLifecycle(type: 'task_started' | 'task_complete', timestamp = CODEX_STARTED_AT): string {
  return JSON.stringify({
    timestamp: new Date(timestamp).toISOString(),
    type: 'event_msg',
    payload: { type, turn_id: 'fixture-turn' },
  });
}

/** Gives provider tests a private Codex home and a child that only holds the fixture lock. */
export async function withCodexCliFixture(
  runTest: (fixture: {
    home: string;
    lockPath: string;
    rolloutPath: string;
    stopHolder: () => Promise<void>;
  }) => Promise<void>,
  options: { held?: boolean; lines?: string[] } = {},
): Promise<void> {
  const previousHome = process.env.CODEX_HOME;
  const home = await mkdtemp(path.join(os.tmpdir(), 'codex-cli-liveness-'));
  const lockPath = path.join(home, 'thread-writer-locks', `${CODEX_THREAD_ID}.lock`);
  const rolloutPath = path.join(home, 'sessions', '2026', '11', '06', `rollout-test-${CODEX_THREAD_ID}.jsonl`);
  await mkdir(path.dirname(lockPath), { recursive: true });
  await mkdir(path.dirname(rolloutPath), { recursive: true });
  await writeFile(lockPath, '');
  await writeFile(rolloutPath, `${(options.lines ?? [codexLifecycle('task_started')]).join('\n')}\n`);
  const holder = options.held === false ? null : spawn(process.execPath, [
    '-e',
    'require("node:fs").openSync(process.argv[1], "r"); process.send("ready"); setInterval(() => {}, 1000);',
    lockPath,
  ], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  /** Stops only the child created by this fixture and waits until its file descriptor closes. */
  async function stopHolder(): Promise<void> {
    if (holder && holder.exitCode === null && holder.signalCode === null) {
      const exited = once(holder, 'exit');
      holder.kill();
      await exited;
    }
  }
  process.env.CODEX_HOME = home;
  try {
    if (holder) await once(holder, 'message');
    await runTest({ home, lockPath, rolloutPath, stopHolder });
  } finally {
    await stopHolder();
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
}
