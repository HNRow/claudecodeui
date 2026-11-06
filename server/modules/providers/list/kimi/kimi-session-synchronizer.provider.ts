import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { sessionsDb } from '@/modules/database/index.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';
import {
  getKimiSessionsRoot,
  isKimiSessionId,
  normalizeProviderTimestamp,
  normalizeSessionName,
  readObjectRecord,
  readOptionalString,
} from '@/shared/utils.js';

const PROVIDER = 'kimi' as const;
const FALLBACK_TITLE = 'Untitled Kimi Session';
const STATE_FILE_NAME = 'state.json';

/** Subset of Kimi's per-session `state.json` this indexer relies on. */
type KimiSessionState = {
  id?: unknown;
  cwd?: unknown;
  title?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  archived?: unknown;
};

/**
 * Indexer for Kimi Code's `$KIMI_CODE_HOME/sessions/<group>/<session>/state.json`.
 *
 * Only metadata is read; the transcript itself is replayed through ACP when the
 * chat opens the session. Files are treated as best-effort: a half-written or
 * malformed state file is skipped without failing the whole scan.
 */
export class KimiSessionSynchronizer implements IProviderSessionSynchronizer {
  async synchronize(since?: Date): Promise<number> {
    const sessionsRoot = getKimiSessionsRoot();
    const stateFiles = await findSessionStateFiles(sessionsRoot);
    const sinceMillis = since?.getTime() ?? null;
    let processed = 0;

    for (const statePath of stateFiles) {
      const state = await readSessionState(statePath);
      if (!state) {
        continue;
      }

      if (sinceMillis !== null) {
        const updatedAt = typeof state.updatedAt === 'number' ? state.updatedAt : 0;
        if (updatedAt < sinceMillis) {
          continue;
        }
      }

      if (this.upsertSession(state, statePath)) {
        processed += 1;
      }
    }

    return processed;
  }

  async synchronizeFile(filePath: string): Promise<string | null> {
    if (path.basename(filePath) !== STATE_FILE_NAME) {
      return null;
    }

    const resolvedPath = path.resolve(filePath);
    const sessionsRoot = path.resolve(getKimiSessionsRoot());
    if (!resolvedPath.startsWith(`${sessionsRoot}${path.sep}`)) {
      return null;
    }

    const state = await readSessionState(resolvedPath);
    if (!state) {
      return null;
    }

    return this.upsertSession(state, resolvedPath) ?? null;
  }

  /**
   * Upserts one indexed session and returns the canonical app session row id.
   *
   * A fresh app session may have been created moments earlier by the chat;
   * binding Kimi's provider id to that pending row first keeps the watcher from
   * adding a second sidebar entry for the same conversation.
   */
  private upsertSession(state: KimiSessionState, statePath: string): string | null {
    if (state.archived === true) {
      return null;
    }

    const sessionId = readOptionalString(state.id);
    const projectPath = readOptionalString(state.cwd);
    if (!sessionId || !isKimiSessionId(sessionId) || !projectPath) {
      return null;
    }

    const pendingAppSession = sessionsDb.getSessionByProviderSessionId(sessionId)
      ?? sessionsDb.getSessionById(sessionId)
      ?? sessionsDb.findLatestPendingAppSession(PROVIDER, projectPath);
    if (pendingAppSession && !pendingAppSession.provider_session_id) {
      sessionsDb.assignProviderSessionId(pendingAppSession.session_id, sessionId);
    }

    const existingSession = sessionsDb.getSessionByProviderSessionId(sessionId)
      ?? sessionsDb.getSessionById(sessionId);
    const existingName = existingSession?.custom_name;
    const title = readOptionalString(state.title);

    const nextName = existingName && existingName !== FALLBACK_TITLE
      ? existingName
      : title;

    const jsonlPath = path.join(path.dirname(statePath), 'agents', 'main', 'wire.jsonl');
    return sessionsDb.createSession(
      sessionId,
      PROVIDER,
      projectPath,
      normalizeSessionName(nextName, FALLBACK_TITLE),
      normalizeProviderTimestamp(state.createdAt),
      normalizeProviderTimestamp(state.updatedAt ?? state.createdAt),
      jsonlPath,
    );
  }
}

/** Lists every `state.json` under the sessions root, tolerating missing roots. */
async function findSessionStateFiles(sessionsRoot: string): Promise<string[]> {
  let groups;
  try {
    groups = await readdir(sessionsRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const stateFiles: string[] = [];
  for (const group of groups) {
    if (!group.isDirectory()) {
      continue;
    }
    const groupPath = path.join(sessionsRoot, group.name);
    let sessions;
    try {
      sessions = await readdir(groupPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const session of sessions) {
      if (!session.isDirectory() || !isKimiSessionId(session.name)) {
        continue;
      }
      stateFiles.push(path.join(groupPath, session.name, STATE_FILE_NAME));
    }
  }

  return stateFiles;
}

async function readSessionState(statePath: string): Promise<KimiSessionState | null> {
  try {
    const content = await readFile(statePath, 'utf8');
    return readObjectRecord(JSON.parse(content)) as KimiSessionState | null;
  } catch {
    // Missing, half-written, or malformed: the next scan tries again.
    return null;
  }
}