import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { Hash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { findCodexHistorySource } from '@/modules/providers/list/codex/codex-sessions.provider.js';
import { isProcessAlive, readObjectRecord } from '@/shared/utils.js';

type LiveCodexCliSession = { providerSessionId: string; startedAt: number };
type LockCandidate = { providerSessionId: string; lockPath: string; mtimeMs: number };
type TurnState = { busy: boolean; startedAt?: number };
type CachedRollout = {
  mtimeMs: number;
  size: number;
  ino: number;
  dev: number;
  state: TurnState;
  pending: Buffer;
  fingerprint: Hash;
  corrupt: boolean;
};

const runFile = promisify(execFile);
const MAX_LOCK_FILES = 256;
const MAX_LINE_BYTES = 4 * 1024 * 1024;
const THREAD_LOCK_NAME = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.lock$/i;
const rolloutCache = new Map<string, CachedRollout>();

/**
 * Resolves `lsof` once, preferring absolute paths.
 *
 * A server launched by the desktop app inherits the GUI environment, whose
 * PATH can omit /usr/sbin — and then `lsof` is not found, every lock looks
 * unheld, and the runtime resumes a thread another Codex client still owns.
 */
const LSOF_CANDIDATES = ['/usr/sbin/lsof', '/usr/bin/lsof', '/bin/lsof'];

/** `CODEX_LSOF_PATH` overrides discovery, for unusual installs and for tests. */
async function resolveLsofCommand(): Promise<string> {
  const configured = process.env.CODEX_LSOF_PATH?.trim();
  if (configured) {
    return configured;
  }

  for (const candidate of LSOF_CANDIDATES) {
    try {
      await fsp.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Try the next well-known location.
    }
  }
  return 'lsof';
}

/** Used by the Codex runtime to avoid a second writer even when an idle daemon retains its thread lock. */
export async function hasCodexCliWriter(providerSessionId: string): Promise<boolean> {
  const name = `${providerSessionId}.lock`;
  if (!THREAD_LOCK_NAME.test(name)) return false;
  const home = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  const lock = await readLockCandidate(path.join(home, 'thread-writer-locks', name), providerSessionId);
  return lock !== null && (await listHeldLockPaths([lock])).has(lock.lockPath);
}

/** Used by the sessions service to report external Codex turns with both a live writer and unfinished task. */
export async function listBusyCodexCliSessions(): Promise<LiveCodexCliSession[]> {
  const home = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  const locks = await readLockCandidates(path.join(home, 'thread-writer-locks'));
  const heldPaths = await listHeldLockPaths(locks);
  const sessions = await Promise.all(locks.filter((lock) => heldPaths.has(lock.lockPath)).map(async (lock) => {
    try {
      const rolloutPath = await findCodexHistorySource(null, lock.providerSessionId);
      if (!rolloutPath) return null;
      const state = await readTurnState(rolloutPath);
      if (!state?.busy) return null;
      return { providerSessionId: lock.providerSessionId, startedAt: state.startedAt ?? lock.mtimeMs };
    } catch {
      // Files can disappear between discovery and reading; one bad thread must not fail the poll.
      return null;
    }
  }));
  return sessions.filter((session): session is LiveCodexCliSession => session !== null);
}

/** Reads at most 256 regular, empty UUID lock files; symlinks and malformed names are not evidence. */
async function readLockCandidates(directory: string): Promise<LockCandidate[]> {
  try {
    const entries = (await fsp.readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && THREAD_LOCK_NAME.test(entry.name)).slice(0, MAX_LOCK_FILES);
    const locks = await Promise.all(entries.map((entry) => readLockCandidate(path.join(directory, entry.name), entry.name.slice(0, -5))));
    return locks.filter((lock): lock is LockCandidate => lock !== null);
  } catch {
    return [];
  }
}

/** Validates one regular empty lock without following a symlink; missing or abnormal files are not writer evidence. */
async function readLockCandidate(lockPath: string, providerSessionId: string): Promise<LockCandidate | null> {
  try {
    const info = await fsp.lstat(lockPath);
    if (!info.isFile() || info.size !== 0) return null;
    return { providerSessionId, lockPath: await fsp.realpath(lockPath), mtimeMs: info.mtimeMs };
  } catch {
    return null;
  }
}

/** Rechecks open descriptors and PID liveness every poll; no shell or cached process evidence is used. */
async function listHeldLockPaths(locks: LockCandidate[]): Promise<Set<string>> {
  const held = new Set<string>();
  if (locks.length === 0) return held;
  let stdout: string;
  try {
    ({ stdout } = await runFile(await resolveLsofCommand(), ['-nP', '-F0pn', '--', ...locks.map((lock) => lock.lockPath)], {
      timeout: 2000, maxBuffer: 1024 * 1024, encoding: 'utf8',
    }));
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
    // lsof exits 1 when any requested lock has no matches, even while reporting
    // other held locks. Accept only that normal partial match, without diagnostics.
    if (failure.code !== 1 || typeof failure.stdout !== 'string' || failure.stderr !== '') return held;
    stdout = failure.stdout;
  }
  const candidates = new Set(locks.map((lock) => lock.lockPath));
  let live = false;
  for (const rawField of stdout.split('\0')) {
    const field = rawField.replace(/^\n/, '');
    if (field.startsWith('p')) {
      const pid = Number(field.slice(1));
      live = Number.isSafeInteger(pid) && pid > 0 && isProcessAlive(pid);
    } else if (live && field.startsWith('n') && candidates.has(field.slice(1))) {
      held.add(field.slice(1));
    }
  }
  return held;
}

/** Caches stable rollouts by path/mtime/size, streams append-only suffixes, and resets on replacement or truncation. */
async function readTurnState(rolloutPath: string): Promise<TurnState | null> {
  try {
    const info = await fsp.lstat(rolloutPath);
    if (!info.isFile()) return null;
    const previous = rolloutCache.get(rolloutPath);
    const sameFile = previous?.ino === info.ino && previous.dev === info.dev;
    if (sameFile && previous.mtimeMs === info.mtimeMs && previous.size === info.size) {
      return !previous.corrupt && previous.pending.length === 0 ? previous.state : null;
    }
    const appendOnly = sameFile && info.size > previous.size && await matchesPreviousContents(rolloutPath, previous);
    const parsed: CachedRollout = {
      mtimeMs: info.mtimeMs, size: info.size, ino: info.ino, dev: info.dev,
      state: appendOnly ? previous.state : { busy: false },
      pending: appendOnly ? previous.pending : Buffer.alloc(0),
      fingerprint: appendOnly ? previous.fingerprint.copy() : createHash('sha256'),
      corrupt: appendOnly ? previous.corrupt : false,
    };
    const start = appendOnly ? previous.size : 0;
    if (info.size > start) {
      const input = fs.createReadStream(rolloutPath, { start, end: info.size - 1 });
      try {
        for await (const chunk of input) {
          parsed.fingerprint.update(chunk as Buffer);
          const data = Buffer.concat([parsed.pending, chunk as Buffer]);
          let offset = 0;
          let newline: number;
          while ((newline = data.indexOf(10, offset)) !== -1) {
            const line = data.subarray(offset, newline);
            if (line.length > MAX_LINE_BYTES) parsed.corrupt = true;
            else observeLifecycle(line.toString('utf8'), parsed);
            offset = newline + 1;
          }
          parsed.pending = Buffer.from(data.subarray(offset));
          if (parsed.pending.length > MAX_LINE_BYTES) return null;
        }
      } finally {
        input.destroy();
      }
    }
    const after = await fsp.lstat(rolloutPath);
    if (after.ino !== info.ino || after.dev !== info.dev || after.size !== info.size || after.mtimeMs !== info.mtimeMs) return null;
    if (rolloutCache.size >= MAX_LOCK_FILES) rolloutCache.delete(rolloutCache.keys().next().value!);
    rolloutCache.set(rolloutPath, parsed);
    return !parsed.corrupt && parsed.pending.length === 0 ? parsed.state : null;
  } catch {
    rolloutCache.delete(rolloutPath);
    return null;
  }
}

/** Validates the complete old prefix before incremental parsing; arbitrary growing rewrites must reset lifecycle state. */
async function matchesPreviousContents(rolloutPath: string, previous: CachedRollout): Promise<boolean> {
  if (previous.size === 0) return true;
  const fingerprint = createHash('sha256');
  const input = fs.createReadStream(rolloutPath, { start: 0, end: previous.size - 1 });
  let bytesRead = 0;
  try {
    for await (const chunk of input) {
      bytesRead += (chunk as Buffer).length;
      fingerprint.update(chunk as Buffer);
    }
    return bytesRead === previous.size && fingerprint.digest('hex') === previous.fingerprint.copy().digest('hex');
  } finally {
    input.destroy();
  }
}

/** Tracks only Codex task lifecycle events; malformed JSON fails closed instead of preserving stale busy state. */
function observeLifecycle(line: string, parsed: CachedRollout): void {
  if (!line.trim()) return;
  try {
    const entry = readObjectRecord(JSON.parse(line));
    if (!entry) {
      parsed.corrupt = true;
      return;
    }
    const payload = readObjectRecord(entry.payload);
    if (entry.type !== 'event_msg' || !payload) return;
    if (payload.type === 'task_complete') parsed.state = { busy: false };
    else if (payload.type === 'task_started') {
      const timestamp = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
      parsed.state = { busy: true, startedAt: Number.isFinite(timestamp) ? timestamp : undefined };
    }
  } catch {
    parsed.corrupt = true;
  }
}
