# Kimi history fallback design

## Context

CloudCLI indexes Kimi session metadata correctly, but session `session_924b41a7-844f-4749-ba38-4e2d4d9f5dc0` opens with no historical messages. Its main `wire.jsonl` exists and contains about 9.8 MB of records. Kimi CLI 2.5.2 returns ACP error `-32603: Internal error` for both `session/load` and `session/resume`, while other Kimi sessions replay successfully.

`KimiSessionsProvider.fetchHistory()` currently catches every history error and returns an empty result. The chat therefore renders its empty-session view, including the unrelated TaskMaster project banner.

## Goals

- Keep ACP `session/load` as the normal Kimi history path.
- When ACP replay fails, recover the visible main-agent transcript from the session's existing `wire.jsonl` without modifying Kimi data.
- Preserve the existing normalized-message contract, chronological ordering, and tail-based pagination.
- If both ACP and fallback fail, report a history-loading error instead of returning a misleading successful empty transcript.

## Non-goals

- Do not repair, rewrite, migrate, or delete Kimi session files.
- Do not change TaskMaster configuration or its empty-state banner.
- Do not parse subagent wire files as separate top-level conversations.
- Do not replace ACP for sessions that replay successfully.

## Design

### Fallback location and ownership

Keep the fallback inside the Kimi provider's session adapter. `KimiSessionsProvider.fetchHistory()` first calls the existing ACP history loader. On failure, it locates the provider session under `$KIMI_CODE_HOME/sessions/<workspace>/<session-id>/` and reads only `agents/main/wire.jsonl`.

A module-private fallback reader converts supported wire records into the same `NormalizedMessage` rows used by ACP history. It reads the file incrementally as JSONL and skips malformed or unknown records rather than failing the entire transcript.

### Record conversion

The fallback handles the main agent's persisted user messages and assistant loop events:

- user text messages;
- assistant text and thinking parts;
- tool calls and tool results;
- existing plan/task updates when represented by supported tool events.

Synthetic system reminders, plugin bootstrap content, bookkeeping events, token-usage records, compaction metadata, and raw protocol payloads do not become user-visible chat rows. Tool rows retain stable identifiers derived from the provider session and wire record identity so repeated refreshes do not duplicate them.

The reader uses record timestamps when valid. Missing timestamps fall back to deterministic positions anchored to the session's `updatedAt`, matching the existing ACP history behavior. Events remain in wire order.

### Pagination and errors

Fallback produces one full normalized transcript and then uses the existing `sliceTailPage()` logic. The API's `limit`, `offset`, `total`, and `hasMore` semantics remain unchanged.

If ACP fails but fallback returns messages, the request succeeds and the original ACP error is logged only as diagnostic context. If no fallback transcript can be read, or neither path yields any restorable rows for a session whose wire file exists, the original error is propagated through the existing route error handling. A genuinely empty new session still returns an empty successful result.

The frontend keeps its existing session-history error path; no new banner or separate synchronization state is introduced.

## Testing

Add focused provider tests with temporary Kimi session fixtures:

1. ACP success does not read or use fallback data.
2. ACP failure with a valid wire file restores user, assistant, thinking, and tool rows in order.
3. Synthetic context, compaction records, malformed lines, and unknown records are skipped.
4. Fallback results preserve tail pagination and stable message IDs.
5. Missing or unreadable fallback data does not become a false empty transcript when the session contains history that failed to replay.

Run the Kimi provider tests, the full test suite using the repository's Node 22 test command, client lint, and the production build without rebuilding native modules. Finally open the affected URL and verify that its historical conversation appears while the independent TaskMaster project banner may remain.

## Verification of the original scenario

Use `http://10.0.0.140:3001/session/session_924b41a7-844f-4749-ba38-4e2d4d9f5dc0` after rebuilding and restarting the CloudCLI server. Confirm that the messages API returns a nonzero total and the page renders prior user and assistant content. Confirm that other Kimi sessions still use ACP and continue to load normally.
