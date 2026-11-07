# Kimi History Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore Kimi history when ACP replay fails by reading the main agent's existing `wire.jsonl`, and stop presenting replay failures as successful empty conversations.

**Architecture:** Keep `KimiSessionsProvider` as the public provider adapter and add a module-private wire-history reader. Inject the ACP and wire loaders into the provider constructor so fallback behavior can be tested without spawning Kimi. Production construction remains unchanged.

**Tech Stack:** TypeScript, Node.js `node:test`, `node:fs`, `node:readline`, Vitest for the full repository suite, existing CloudCLI provider interfaces.

## Global Constraints

- Follow `docs/superpowers/specs/2026-11-06-kimi-history-fallback-design.md`.
- Never modify Kimi session source files.
- Keep ACP as the primary history source; use wire fallback only after ACP fails.
- Do not change TaskMaster or unrelated frontend code.
- Use Node 22 for Vitest: `npx -y node@22 node_modules/vitest/vitest.mjs run`.
- Keep the existing Node 26 server and native `better-sqlite3` installation unchanged.
- Do not create Git commits unless the user separately requests them.

---

### Task 1: Main-agent wire history reader

**Files:**
- Create: `server/modules/providers/list/kimi/kimi-wire-history.ts`
- Create: `server/modules/providers/tests/kimi-wire-history.test.ts`

**Interfaces:**
- Consumes: `createNormalizedMessage()`, `getKimiSessionsRoot()`, `readObjectRecord()`, and `readOptionalString()` from `server/shared/`; `NormalizedMessage` from `server/shared/types.ts`.
- Produces: `loadKimiWireHistory(providerSessionId: string): Promise<NormalizedMessage[]>` for `KimiSessionsProvider`.

- [ ] **Step 1: Write failing reader tests**

Create `server/modules/providers/tests/kimi-wire-history.test.ts` with a temporary `$KIMI_CODE_HOME` fixture at `sessions/workspace/session_fake/agents/main/wire.jsonl`. Use `node:test` with `{ concurrency: false }`, restore `KIMI_CODE_HOME` after each test, and delete the temporary directory.

The main fixture must contain, in order:

```json
{"type":"metadata","protocol_version":"1.5","created_at":1700000000000}
{"type":"context.append_message","agentId":"main","time":1700000001000,"message":{"id":"u1","origin":{"kind":"user"},"role":"user","content":[{"type":"text","text":"hello"}],"toolCalls":[]}}
{"type":"context.append_message","agentId":"main","time":1700000002000,"message":{"origin":{"kind":"injection","variant":"date_change"},"role":"user","content":[{"type":"text","text":"injected"}],"toolCalls":[]}}
{"type":"context.append_loop_event","time":1700000003000,"event":{"type":"content.part","stepUuid":"s1","part":{"type":"think","think":"thinking"}}}
{"type":"context.append_loop_event","time":1700000004000,"event":{"type":"content.part","stepUuid":"s1","part":{"type":"text","text":"answer"}}}
{"type":"context.append_loop_event","time":1700000005000,"event":{"type":"tool.call","toolCallId":"tc1","name":"Read","args":{"path":"a.ts"}}}
{"type":"context.append_loop_event","time":1700000006000,"event":{"type":"tool.result","toolCallId":"tc1","result":{"output":"file body","durationMs":1}}}
{"type":"context.apply_compaction","summary":"not a visible message"}
```

Append one malformed JSON line in a second fixture. Assert:

```ts
const messages = await loadKimiWireHistory('session_fake');
assert.deepEqual(messages.map((message) => message.kind), [
  'text', 'thinking', 'text', 'tool_use', 'tool_result',
]);
assert.deepEqual(messages.map((message) => message.content), [
  'hello', 'thinking', 'answer', undefined, 'file body',
]);
assert.equal(messages[0]?.role, 'user');
assert.equal(messages[2]?.role, 'assistant');
assert.equal(messages[3]?.toolId, 'tc1');
assert.equal(messages[4]?.toolId, 'tc1');
assert.equal(messages.every((message) => message.provider === 'kimi'), true);
assert.equal(new Set(messages.map((message) => message.id)).size, messages.length);
assert.deepEqual(
  messages.map((message) => message.timestamp),
  ['2023-11-14T22:13:21.000Z', '2023-11-14T22:13:23.000Z',
   '2023-11-14T22:13:24.000Z', '2023-11-14T22:13:25.000Z',
   '2023-11-14T22:13:26.000Z'],
);
```

Also assert that a malformed line and an unknown record are skipped, a missing wire file rejects, and two reads produce identical IDs. Use `assert.rejects()` for the missing file rather than converting it to an empty transcript.

- [ ] **Step 2: Run the reader tests and verify RED**

Run:

```bash
npx -y node@22 node_modules/vitest/vitest.mjs run server/modules/providers/tests/kimi-wire-history.test.ts
```

Expected: FAIL because `kimi-wire-history.ts` does not exist.

- [ ] **Step 3: Implement the minimal wire reader**

Create `server/modules/providers/list/kimi/kimi-wire-history.ts`. Use `createReadStream()` plus `readline.createInterface()` so a large file is parsed one line at a time. Store parsed records with their one-based line number, then convert them in wire order.

The public entry point is:

```ts
export async function loadKimiWireHistory(providerSessionId: string): Promise<NormalizedMessage[]> {
  const wirePath = await findMainWirePath(providerSessionId);
  if (!wirePath) throw new Error(`Kimi wire history was not found for ${providerSessionId}.`);
  const records = await readWireRecords(wirePath);
  const anchorTime = await readSessionUpdatedAt(wirePath);
  return buildWireHistoryMessages(records, providerSessionId, anchorTime);
}
```

`findMainWirePath()` lists only immediate workspace directories below `getKimiSessionsRoot()`, checks `<workspace>/<providerSessionId>/agents/main/wire.jsonl` with `stat()`, and returns the first file. Missing roots and workspaces return `null`; do not scan subagent files.

`readWireRecords()` skips blank lines, malformed JSON, non-object records, and unsupported record types. Supported types are `context.append_message` and `context.append_loop_event`.

Conversion rules:

```ts
// User rows: only genuine user-originated messages, not injected context.
if (record.type === 'context.append_message'
  && message.role === 'user'
  && readObjectRecord(message.origin)?.kind === 'user') {
  const content = message.content
    .filter((part) => readObjectRecord(part)?.type === 'text')
    .map((part) => readObjectRecord(part)?.text)
    .filter((text): text is string => typeof text === 'string' && text.length > 0)
    .join('\n');
  if (content) pushTextMessage('text', 'user', content);
}

// Assistant rows: persisted complete text/thinking parts.
if (record.type === 'context.append_loop_event' && event.type === 'content.part') {
  if (part.type === 'text' && typeof part.text === 'string' && part.text) {
    pushTextMessage('text', 'assistant', part.text);
  }
  if (part.type === 'think' && typeof part.think === 'string' && part.think) {
    pushTextMessage('thinking', 'assistant', part.think);
  }
}
```

For `tool.call`, emit `kind: 'tool_use'`, `toolId: event.toolCallId`, `toolName: event.name ?? 'Tool'`, and `toolInput: event.args ?? {}`. For `tool.result`, emit `kind: 'tool_result'`, the same `toolId`, and text from `event.result.output`; strings stay unchanged and other non-null values use formatted JSON. Use `event.result.isError === true` for `isError` when present.

Create IDs as `kimi_wire_${providerSessionId}_${lineNumber}_${kind}`. Use a valid numeric record `time` as milliseconds; otherwise use `anchorTime - (records.length - recordIndex) * 1000`. `readSessionUpdatedAt()` reads `state.json` three directories above `agents/main/wire.jsonl` and returns a finite numeric `updatedAt`, or `undefined`.

Every row uses `createNormalizedMessage()` with `sessionId: providerSessionId` and `provider: 'kimi'`.

- [ ] **Step 4: Run the reader tests and verify GREEN**

Run the Step 2 command again. Expected: all `kimi-wire-history.test.ts` tests PASS.

---

### Task 2: Provider fallback and failure propagation

**Files:**
- Modify: `server/modules/providers/list/kimi/kimi-sessions.provider.ts:42-93`
- Modify: `server/modules/providers/tests/kimi-provider.test.ts:11-14`

**Interfaces:**
- Consumes: `loadKimiWireHistory(providerSessionId)` from Task 1.
- Produces: existing `KimiSessionsProvider.fetchHistory()` behavior, with constructor injection available only for focused tests.

- [ ] **Step 1: Add failing provider fallback tests**

Import `KimiSessionsProvider` in `kimi-provider.test.ts`. Add tests using constructor-injected loader functions:

```ts
test('Kimi history uses wire fallback only after ACP fails', async () => {
  const calls: string[] = [];
  const fallbackMessage = buildHistoryMessages([
    { sessionUpdate: 'agent_message_chunk', messageId: 'a1', content: { type: 'text', text: 'recovered' } },
  ] as never, 'session_fake', 1700000000000)[0];
  const provider = new KimiSessionsProvider({
    loadAcpHistory: async () => { calls.push('acp'); throw new Error('ACP failed'); },
    loadWireHistory: async () => { calls.push('wire'); return [fallbackMessage]; },
  });
  const result = await provider.fetchHistory('session_fake', { limit: 20, offset: 0 });
  assert.deepEqual(calls, ['acp', 'wire']);
  assert.equal(result.total, 1);
  assert.equal(result.messages[0]?.content, 'recovered');

  const healthy = new KimiSessionsProvider({
    loadAcpHistory: async () => [fallbackMessage],
    loadWireHistory: async () => { throw new Error('must not be called'); },
  });
  assert.equal((await healthy.fetchHistory('session_fake')).total, 1);
});
```

Add a second test where both injected loaders reject and assert `assert.rejects(provider.fetchHistory('session_fake'), /ACP failed/)`. Add a third where ACP rejects and wire resolves `[]`; assert the same rejection, proving a failed replay cannot become a false empty result. Keep existing pagination tests unchanged and add one fallback assertion with `limit: 1` if needed to prove the existing `sliceTailPage()` path still applies.

- [ ] **Step 2: Run provider tests and verify RED**

Run:

```bash
npx -y node@22 node_modules/vitest/vitest.mjs run server/modules/providers/tests/kimi-provider.test.ts
```

Expected: FAIL because the constructor does not accept loader overrides and ACP errors are still converted to empty history.

- [ ] **Step 3: Implement fallback selection**

Import `loadKimiWireHistory` using the provider's existing alias style. Add a module-local options type and constructor:

```ts
type KimiSessionsProviderOptions = {
  loadAcpHistory?: typeof loadKimiHistory;
  loadWireHistory?: typeof loadKimiWireHistory;
};

private readonly loadAcpHistory: typeof loadKimiHistory;
private readonly loadWireHistory: typeof loadKimiWireHistory;

constructor({
  loadAcpHistory = loadKimiHistory,
  loadWireHistory = loadKimiWireHistory,
}: KimiSessionsProviderOptions = {}) {
  this.loadAcpHistory = loadAcpHistory;
  this.loadWireHistory = loadWireHistory;
}
```

Replace the catch-to-empty behavior inside `fetchHistory()` with:

```ts
try {
  messages = await this.loadAcpHistory(providerSessionId, options.projectPath);
} catch (acpError) {
  console.warn('[Kimi] ACP history failed; trying wire fallback:', formatKimiError(acpError));
  try {
    messages = await this.loadWireHistory(providerSessionId);
  } catch (fallbackError) {
    console.warn('[Kimi] Wire history fallback failed:', formatKimiError(fallbackError));
    throw acpError;
  }
  if (messages.length === 0) throw acpError;
}
```

Leave valid-provider checks, slicing, return values, live normalization, and all other providers unchanged.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
npx -y node@22 node_modules/vitest/vitest.mjs run \
  server/modules/providers/tests/kimi-wire-history.test.ts \
  server/modules/providers/tests/kimi-provider.test.ts \
  server/modules/providers/tests/kimi-session-sync.test.ts
```

Expected: all three files PASS.

---

### Task 3: Repository checks and original-session verification

**Files:**
- No source files planned; only generated build output may change.

**Interfaces:**
- Consumes: completed provider fallback from Tasks 1 and 2.
- Produces: a running CloudCLI build that displays the affected Kimi conversation.

- [ ] **Step 1: Run the full test suite**

Run:

```bash
npx -y node@22 node_modules/vitest/vitest.mjs run
```

Expected: all tests PASS. Do not claim success if unrelated tests fail; report their exact names and keep them separate from this change.

- [ ] **Step 2: Run lint, typecheck, and production build**

Run:

```bash
npm run lint:client
npm run typecheck
npm run build
```

Expected: lint has no errors, typecheck has no new failure, and build succeeds. The previously observed `recentConversationTitleSync.test.ts` fixture error is unrelated if still present; do not modify it as part of this fix.

- [ ] **Step 3: Restart the actual CloudCLI server**

Stop only the existing project server process and restart it with the same established CloudCLI launch flow. Do not rebuild Node 22 native modules or replace the user's running Kimi CLI processes.

Verify the messages endpoint for `session_924b41a7-844f-4749-ba38-4e2d4d9f5dc0` returns `success: true`, `total > 0`, and nonempty `messages`.

- [ ] **Step 4: Verify the browser result and cleanup**

Open:

```text
http://10.0.0.140:3001/session/session_924b41a7-844f-4749-ba38-4e2d4d9f5dc0
```

Confirm prior user and assistant content appears, the view no longer presents the conversation as empty, and a second healthy Kimi session still loads. The TaskMaster banner may remain because it is independent project state.

Close only the browser tabs opened for this verification. Run `git status --short` and remove only temporary files created by these checks; do not remove pre-existing user changes or generated files needed by CloudCLI.
