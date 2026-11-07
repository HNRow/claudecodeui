# Kimi CLI liveness design

## Context

The running-sessions endpoint includes CloudCLI-owned chat runs, provider background work, and external Claude CLI busy sessions. It has no equivalent detection for turns driven by an external Kimi CLI, so those conversations appear idle in the sidebar.

Kimi writes `$KIMI_CODE_HOME/locks/sessions/<session-id>.lock` with the owning PID and lock acquisition time. A lock covers the process/session lifetime rather than one turn. The main agent's `wire.jsonl` records `agent.turn.started` and `agent.turn.ended`, which provide the missing busy/idle distinction.

## Goals

- Report an external Kimi session as running only while its owning process is alive and its latest main-agent turn is unfinished.
- Reuse the existing running-sessions response, polling, and sidebar indicators.
- Treat stale locks, completed turns, malformed data, and missing files as not running.
- Avoid reparsing an unchanged wire log on every poll.

## Non-goals

- Do not allow CloudCLI to interrupt externally owned Kimi processes.
- Do not infer activity from log recency alone.
- Do not treat an open but idle Kimi session as busy.
- Do not modify Kimi lock, state, or wire files.
- Do not change external liveness behavior for other providers.

## Detection flow

Create a provider-module liveness service that scans `$KIMI_CODE_HOME/locks/sessions/` with a bounded file count. For each `.lock` file:

1. Read the provider session ID from the filename and require the existing Kimi session-ID format.
2. Parse the lock JSON and require a positive integer `pid`.
3. Probe the PID with `process.kill(pid, 0)`; `EPERM` means the process exists, while other failures reject the entry.
4. Locate the session's existing main-agent wire path and determine the latest main-agent turn lifecycle state.
5. Return a live entry only when the latest lifecycle record is `agent.turn.started` with no later `agent.turn.ended`.

A lock with a live PID but a completed turn is idle. A started turn with a dead PID is stale. Missing or unreadable data produces no entry and does not fail the running-sessions endpoint.

The entry contains `providerSessionId` and the turn's `startedAt`. If the lifecycle record has no valid timestamp, the lock's `startedAt` is used; otherwise the current time is the final fallback, matching the existing Claude adapter's defensive behavior.

## Wire-state cache

Cache turn state by wire-file path, file size, and modification time. A poll with an unchanged file reuses the parsed state. A changed file is read as JSONL and scanned in order for main-agent `agent.turn.started` and `agent.turn.ended` records; unrelated loop events, subagent events, malformed lines, and unknown records are ignored.

The cache stores only the derived turn state, not message content. PID liveness is checked on every poll and is never cached.

## Running-sessions integration

Extend `sessionsService.listRunningSessions()` with a Kimi-specific merge parallel to the Claude merge:

- resolve the app session through `sessionsDb.getSessionByProviderSessionId()`;
- skip unknown sessions and sessions already present from CloudCLI's own run registry or background-work list;
- add `provider: 'kimi'`, `canInterrupt: false`, and `statusText: 'Running in the Kimi CLI'`;
- preserve the richer existing entry when the same session is already running inside CloudCLI.

No frontend or API shape change is required.

## Testing

Add focused tests with temporary Kimi homes and fixture files for:

1. a live PID and unfinished turn returns one running session;
2. a finished turn returns no session even while its PID is alive;
3. an unfinished turn with a dead PID returns no session;
4. malformed locks, invalid session IDs, missing wire files, and malformed wire lines are ignored;
5. an unchanged wire file is parsed once across repeated reads, while a changed file invalidates the cache;
6. the sessions service maps a live external Kimi session to its app-facing ID without interrupt capability;
7. an existing CloudCLI-owned run keeps its richer entry instead of being overwritten.

Run the focused provider tests, complete server and client suites, lint, server typecheck, and production build. Verify the original `session_924b41a7-844f-4749-ba38-4e2d4d9f5dc0` appears while its current turn is active, then verify a completed or idle Kimi session does not appear. Do not stop or alter the user's external Kimi process to create the test condition.
