# Kimi CLI Liveness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show external Kimi CLI sessions as running only while their owning process is alive and a main-agent turn is unfinished.

**Architecture:** Add a Kimi liveness adapter that joins Kimi session locks with cached main-agent turn state. Merge its results into the existing sessions service with the same app-session mapping and non-interruptible external-run semantics used for Claude.

**Tech Stack:** TypeScript, Node.js `node:test`, `node:fs`, `node:readline`, existing CloudCLI provider services and database repositories.

## Global Constraints

- Follow `docs/superpowers/specs/2026-11-06-kimi-cli-liveness-design.md`.
- Never modify Kimi lock, state, or wire files.
- A live process alone is not busy; the latest main-agent turn must be unfinished.
- Do not infer activity from recency and do not allow interruption of external Kimi processes.
- Keep CloudCLI-owned run entries richer than external-liveness entries.
- Do not change frontend code or unrelated providers' behavior.
- Do not create Git commits unless separately requested.

---

### Task 1: Shared probes and Kimi wire-path reuse

**Files:**
- Modify: `server/shared/utils.ts`
- Modify: `server/modules/providers/services/claude-cli-liveness.service.ts`
- Modify: `server/modules/providers/list/kimi/kimi-wire-history.ts`
- Test: `server/modules/providers/tests/claude-sessions.test.ts`
- Test: `server/modules/providers/tests/kimi-wire-history.test.ts`

**Interfaces:**
- Produces: `isProcessAlive(pid: number): boolean` from `server/shared/utils.ts`.
- Produces: `findKimiMainWirePath(providerSessionId: string): Promise<string | null>` from `kimi-wire-history.ts`.

- [ ] **Step 1: Run existing probes as the refactor baseline**

Run:

```bash
npx tsx --tsconfig server/tsconfig.json --test \
  server/modules/providers/tests/claude-sessions.test.ts \
  server/modules/providers/tests/kimi-wire-history.test.ts
```

Expected: PASS before changing the shared helpers.

- [ ] **Step 2: Extract the unchanged process probe**

Move only the signal-0 portion of Claude's `isRecordedProcessAlive()` into shared utils:

```ts
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}
```

Add a doc comment explaining that signal 0 does not send a signal and `EPERM` still proves existence. In Claude's helper, replace the try/catch with `if (!isProcessAlive(pid)) return false;`, retaining the Linux `procStart` verification unchanged.

- [ ] **Step 3: Export the existing Kimi wire-path finder**

Rename `findMainWirePath()` to `findKimiMainWirePath()`, export it, and update the existing call in `loadKimiWireHistory()`. Its lookup behavior stays unchanged. Add a consumer comment naming the history and liveness adapters.

- [ ] **Step 4: Re-run baseline tests**

Run the Step 1 command. Expected: PASS, proving no behavior changed.

---

### Task 2: Kimi lock and turn-state adapter

**Files:**
- Create: `server/modules/providers/services/kimi-cli-liveness.service.ts`
- Create: `server/modules/providers/tests/kimi-cli-liveness.test.ts`

**Interfaces:**
- Consumes: `findKimiMainWirePath()`, `getKimiCodeHome()`, `isKimiSessionId()`, `isProcessAlive()`, and `readObjectRecord()`.
- Produces: `listBusyKimiCliSessions(): Promise<Array<{ providerSessionId: string; startedAt: number }>>`.

- [ ] **Step 1: Write failing liveness tests**

Create tests that set `KIMI_CODE_HOME` to a temporary directory containing:

```text
locks/sessions/session_00000000-0000-4000-8000-000000000001.lock
sessions/workspace/session_00000000-0000-4000-8000-000000000001/agents/main/wire.jsonl
```

The lock body is:

```ts
{ pid: process.pid, startedAt: 1_700_000_000_000, clientIdentity: 'kimi_code_cli' }
```

The busy wire fixture is:

```ts
JSON.stringify({ type: 'agent.turn.started', time: 1_700_000_000_100 }) + '\n' +
JSON.stringify({ type: 'context.append_loop_event', event: { type: 'tool.call' } }) + '\n'
```

Use `node:test` with `{ concurrency: false }`; restore the environment and delete every temporary directory. Test these behaviors separately:

```ts
assert.deepEqual(await listBusyKimiCliSessions(), [{
  providerSessionId: SESSION_ID,
  startedAt: 1_700_000_000_100,
}]);
```

- a live PID plus `agent.turn.started` returns the entry above;
- appending `agent.turn.ended` makes the next read return `[]`;
- replacing the lock PID with `4_194_302` makes an unfinished turn return `[]`;
- malformed lock JSON, a lock filename that fails `isKimiSessionId()`, missing wire files, and malformed wire lines return `[]` without throwing;
- repeated reads of unchanged busy and idle files return the same derived state, and appending a new lifecycle record invalidates the cached state;
- a started record without a valid `time` uses the lock's `startedAt`.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/kimi-cli-liveness.test.ts
```

Expected: FAIL because the liveness module does not exist.

- [ ] **Step 3: Implement lock scanning and PID validation**

Create `kimi-cli-liveness.service.ts` with a 256-file scan bound. Read only `.lock` entries. Derive the provider session ID from the basename, validate it, parse the lock with `readObjectRecord()`, and require a positive integer PID. Skip dead PIDs using `isProcessAlive()` before reading any wire data.

The public function is:

```ts
export async function listBusyKimiCliSessions(): Promise<LiveKimiCliSession[]> {
  const entries = await readLockEntries();
  const sessions = await Promise.all(entries.slice(0, MAX_LOCK_FILES).map(readLiveBusySession));
  return sessions.filter((session): session is LiveKimiCliSession => session !== null);
}
```

`readLockEntries()` returns `[]` when the directory is absent or unreadable. `readLiveBusySession()` returns `null` for every malformed, stale, missing, or idle case.

- [ ] **Step 4: Implement cached turn-state reads**

For a live lock, call `findKimiMainWirePath(providerSessionId)`. Read the wire file incrementally with `createReadStream()` and `readline.createInterface()`. Track only top-level main-agent lifecycle rows:

```ts
if (record.type === 'agent.turn.started') {
  state = { busy: true, startedAt: validTime(record.time) };
} else if (record.type === 'agent.turn.ended') {
  state = { busy: false, startedAt: undefined };
}
```

Ignore all other records and malformed lines. Return `{ providerSessionId, startedAt: state.startedAt ?? lockStartedAt ?? Date.now() }` only for `busy: true`.

Cache the derived state under the wire path with a signature of `${stat.mtimeMs}:${stat.size}`. Reuse it only when the current stat has the same signature. Never cache PID liveness.

- [ ] **Step 5: Run the adapter tests and verify GREEN**

Run the Step 2 command. Expected: all liveness tests PASS.

---

### Task 3: Merge external Kimi runs into the existing API

**Files:**
- Modify: `server/modules/providers/services/sessions.service.ts:1-212`
- Modify: `server/modules/providers/tests/sessions.service.test.ts`

**Interfaces:**
- Consumes: `listBusyKimiCliSessions()` from Task 2.
- Produces: existing `RunningSessionEntry` with `canInterrupt: false` and `statusText: 'Running in the Kimi CLI'`.

- [ ] **Step 1: Add failing sessions-service tests**

Add a `withKimiCliSession()` fixture helper that creates a temporary `KIMI_CODE_HOME`, lock, and main wire file using the same shapes as Task 2, restores the environment, and removes the directory.

Add a mapping test:

```ts
sessionsDb.createAppSession('kimi-cli-app', 'kimi', '/tmp/running-project');
sessionsDb.assignProviderSessionId('kimi-cli-app', SESSION_ID);
// Lock PID = process.pid; wire contains one started turn at 4_000.
assert.deepEqual(await sessionsService.listRunningSessions(), [{
  sessionId: 'kimi-cli-app',
  provider: 'kimi',
  startedAt: 4_000,
  lastSeq: 0,
  canInterrupt: false,
  statusText: 'Running in the Kimi CLI',
}]);
```

Run it inside `withIsolatedDatabase()`, the Kimi fixture, `withClaudeCliRegistry([], ...)`, and `withProviders({ kimi: { run: async () => undefined, abort: () => false } }, ...)`. Widen `withProviders()`' runtime record to include `'kimi'`.

Add a deduplication test with the same app session also registered through `chatRunRegistry.startRun()`. Assert only the CloudCLI-owned entry remains, with no `canInterrupt: false` override and no duplicate row. Add an idle-turn test asserting `[]`.

- [ ] **Step 2: Run service tests and verify RED**

Run:

```bash
npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/sessions.service.test.ts
```

Expected: the new Kimi mapping test FAILS because no Kimi entry is returned.

- [ ] **Step 3: Merge the Kimi adapter**

Import `listBusyKimiCliSessions()` and add a loop after the Claude merge:

```ts
for (const live of await listBusyKimiCliSessions()) {
  const session = sessionsDb.getSessionByProviderSessionId(live.providerSessionId);
  if (!session || runningById.has(session.session_id)) continue;
  entries.push({
    sessionId: session.session_id,
    provider: 'kimi',
    startedAt: live.startedAt,
    lastSeq: chatRunRegistry.getRun(session.session_id)?.lastSeq ?? 0,
    canInterrupt: false,
    statusText: 'Running in the Kimi CLI',
  });
  runningById.set(session.session_id, entries[entries.length - 1]!);
}
```

Update the running-session comments so they no longer describe Claude as the only external CLI source. Do not alter the API route or frontend.

- [ ] **Step 4: Run all affected tests and verify GREEN**

Run:

```bash
npx tsx --tsconfig server/tsconfig.json --test \
  server/modules/providers/tests/kimi-cli-liveness.test.ts \
  server/modules/providers/tests/kimi-wire-history.test.ts \
  server/modules/providers/tests/kimi-provider.test.ts \
  server/modules/providers/tests/sessions.service.test.ts \
  server/modules/providers/tests/claude-sessions.test.ts
```

Expected: all affected tests PASS.

---

### Task 4: Full verification and real-session acceptance

**Files:**
- No new source files; generated `dist/` and `dist-server/` output is rebuilt.

**Interfaces:**
- Consumes: completed Kimi liveness detection and sessions-service merge.
- Produces: accurate running indicators in the existing CloudCLI UI.

- [ ] **Step 1: Run full server and client suites**

Run:

```bash
npm test
npx -y node@22 node_modules/vitest/vitest.mjs run
```

Expected: no new failures. The two existing `providerSkillsService` failures may remain; report them separately rather than modifying them.

- [ ] **Step 2: Run static checks and build**

Run:

```bash
npm run lint:server
npm run lint:client
npx tsc --noEmit -p server/tsconfig.json
npm run typecheck
npm run build
```

Expected: server typecheck and build succeed, lint has zero errors, and the existing `recentConversationTitleSync.test.ts` client fixture error is reported separately if it remains.

- [ ] **Step 3: Verify the real active and idle cases without stopping Kimi**

After the existing CloudCLI launch flow reloads the rebuilt server, open the running-sessions API through the authenticated browser session. While `session_924b41a7-844f-4749-ba38-4e2d4d9f5dc0` has an unfinished turn and a live lock PID, assert its entry has `provider: 'kimi'`, `canInterrupt: false`, and the expected status text. Open its conversation URL and verify the list shows the running indicator.

Open `session_545ec704-f54f-4773-8a4a-5953ab764a77` or another completed Kimi session and assert it is absent from running sessions. Do not terminate, pause, or write to the user's Kimi processes to manufacture a result.

- [ ] **Step 4: Clean up only task-owned artifacts**

Close browser tabs opened for verification and remove screenshots or temporary files created by this task. Run `git status --short`; leave all pre-existing user changes and the running CloudCLI service untouched.
