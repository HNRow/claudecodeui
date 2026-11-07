import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

import { findKimiMainWirePath } from '@/modules/providers/list/kimi/kimi-wire-history.js';
import {
  getKimiCodeHome,
  isKimiSessionId,
  isProcessAlive,
  readObjectRecord,
} from '@/shared/utils.js';

type LiveKimiCliSession = {
  providerSessionId: string;
  startedAt: number;
};

type TurnState = {
  busy: boolean;
  startedAt?: number;
};

type CachedTurnState = {
  signature: string;
  state: TurnState;
};

const MAX_LOCK_FILES = 256;
const turnStateCache = new Map<string, CachedTurnState>();

/** Used by the sessions service to report turns driven by an external Kimi CLI. */
export async function listBusyKimiCliSessions(): Promise<LiveKimiCliSession[]> {
  const lockDirectory = path.join(getKimiCodeHome(), 'locks', 'sessions');
  let entries: string[];
  try {
    entries = await readdir(lockDirectory);
  } catch {
    return [];
  }

  const sessions = await Promise.all(
    entries
      .filter((entry) => entry.endsWith('.lock'))
      .slice(0, MAX_LOCK_FILES)
      .map((entry) => readLiveBusySession(path.join(lockDirectory, entry))),
  );
  return sessions.filter((session): session is LiveKimiCliSession => session !== null);
}

/** Resolves one lock to a busy session only when its process and current turn are live. */
async function readLiveBusySession(lockPath: string): Promise<LiveKimiCliSession | null> {
  const providerSessionId = path.basename(lockPath, '.lock');
  if (!isKimiSessionId(providerSessionId)) {
    return null;
  }

  try {
    const lock = readObjectRecord(JSON.parse(await readFile(lockPath, 'utf8')));
    if (!lock) {
      return null;
    }
    const pid = lock.pid;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || !isProcessAlive(pid)) {
      return null;
    }

    const wirePath = await findKimiMainWirePath(providerSessionId);
    if (!wirePath) {
      return null;
    }
    const turn = await readTurnState(wirePath);
    if (!turn?.busy) {
      return null;
    }

    const lockStartedAt = typeof lock.startedAt === 'number' && Number.isFinite(lock.startedAt)
      ? lock.startedAt
      : undefined;
    return {
      providerSessionId,
      startedAt: turn.startedAt ?? lockStartedAt ?? Date.now(),
    };
  } catch {
    return null;
  }
}

/** Returns cached turn state unless the wire file's modification signature changes. */
async function readTurnState(wirePath: string): Promise<TurnState | null> {
  let signature: string;
  try {
    const fileStat = await stat(wirePath);
    signature = `${fileStat.mtimeMs}:${fileStat.size}`;
  } catch {
    return null;
  }

  const cached = turnStateCache.get(wirePath);
  if (cached?.signature === signature) {
    return cached.state;
  }

  const state = await scanTurnState(wirePath);
  if (state) {
    turnStateCache.set(wirePath, { signature, state });
  }
  return state;
}

/** Scans JSONL lifecycle rows and keeps the latest main-agent busy or idle state. */
async function scanTurnState(wirePath: string): Promise<TurnState | null> {
  let state: TurnState = { busy: false };
  const input = createReadStream(wirePath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });

  try {
    for await (const line of lines) {
      if (!line.includes('agent.turn.')) {
        continue;
      }
      try {
        const record = readObjectRecord(JSON.parse(line));
        if (record?.type === 'agent.turn.started') {
          state = {
            busy: true,
            startedAt: typeof record.time === 'number' && Number.isFinite(record.time)
              ? record.time
              : undefined,
          };
        } else if (record?.type === 'agent.turn.ended') {
          state = { busy: false };
        }
      } catch {
        // Ignore a partial lifecycle row and keep the last complete state.
      }
    }
  } catch {
    return null;
  } finally {
    lines.close();
    input.destroy();
  }

  return state;
}
