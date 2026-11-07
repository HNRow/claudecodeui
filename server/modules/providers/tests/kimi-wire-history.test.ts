import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadKimiWireHistory } from '@/modules/providers/list/kimi/kimi-wire-history.js';

const SESSION_ID = 'session_fake';

/** Runs one reader test against an isolated main-agent wire log. */
async function withWireFixture(
  lines: string[],
  runTest: () => Promise<void>,
): Promise<void> {
  const previousHome = process.env.KIMI_CODE_HOME;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'kimi-wire-history-'));
  const sessionDirectory = path.join(tempDirectory, 'sessions', 'workspace', SESSION_ID);
  await mkdir(path.join(sessionDirectory, 'agents', 'main'), { recursive: true });
  await writeFile(
    path.join(sessionDirectory, 'agents', 'main', 'wire.jsonl'),
    `${lines.join('\n')}\n`,
    'utf8',
  );
  process.env.KIMI_CODE_HOME = tempDirectory;

  try {
    await runTest();
  } finally {
    if (previousHome === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = previousHome;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

const VISIBLE_RECORDS = [
  JSON.stringify({ type: 'metadata', protocol_version: '1.5', created_at: 1700000000000 }),
  JSON.stringify({
    type: 'context.append_message', agentId: 'main', time: 1700000001000,
    message: { id: 'u1', origin: { kind: 'user' }, role: 'user', content: [{ type: 'text', text: 'hello' }], toolCalls: [] },
  }),
  JSON.stringify({
    type: 'context.append_message', agentId: 'main', time: 1700000002000,
    message: { origin: { kind: 'injection', variant: 'date_change' }, role: 'user', content: [{ type: 'text', text: 'injected' }], toolCalls: [] },
  }),
  JSON.stringify({
    type: 'context.append_loop_event', time: 1700000003000,
    event: { type: 'content.part', stepUuid: 's1', part: { type: 'think', think: 'thinking' } },
  }),
  JSON.stringify({
    type: 'context.append_loop_event', time: 1700000004000,
    event: { type: 'content.part', stepUuid: 's1', part: { type: 'text', text: 'answer' } },
  }),
  JSON.stringify({
    type: 'context.append_loop_event', time: 1700000005000,
    event: { type: 'tool.call', toolCallId: 'tc1', name: 'Read', args: { path: 'a.ts' } },
  }),
  JSON.stringify({
    type: 'context.append_loop_event', time: 1700000006000,
    event: { type: 'tool.result', toolCallId: 'tc1', result: { output: 'file body', durationMs: 1 } },
  }),
  JSON.stringify({ type: 'context.apply_compaction', summary: 'not a visible message' }),
];

test('wire history restores visible main-agent rows in order', { concurrency: false }, async () => {
  await withWireFixture(VISIBLE_RECORDS, async () => {
    const messages = await loadKimiWireHistory(SESSION_ID);
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
    assert.deepEqual(messages.map((message) => message.timestamp), [
      '2023-11-14T22:13:21.000Z',
      '2023-11-14T22:13:23.000Z',
      '2023-11-14T22:13:24.000Z',
      '2023-11-14T22:13:25.000Z',
      '2023-11-14T22:13:26.000Z',
    ]);
  });
});

test('wire history skips malformed lines and unknown records', { concurrency: false }, async () => {
  await withWireFixture([...VISIBLE_RECORDS, '{not json', '{"type":"future.record"}'], async () => {
    const messages = await loadKimiWireHistory(SESSION_ID);
    assert.equal(messages.length, 5);
  });
});

test('wire history IDs are stable across reads', { concurrency: false }, async () => {
  await withWireFixture(VISIBLE_RECORDS, async () => {
    const first = await loadKimiWireHistory(SESSION_ID);
    const second = await loadKimiWireHistory(SESSION_ID);
    assert.deepEqual(first.map((message) => message.id), second.map((message) => message.id));
  });
});

test('missing wire history rejects instead of returning an empty transcript', { concurrency: false }, async () => {
  const previousHome = process.env.KIMI_CODE_HOME;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'kimi-wire-missing-'));
  process.env.KIMI_CODE_HOME = tempDirectory;
  try {
    await assert.rejects(loadKimiWireHistory(SESSION_ID), /wire history was not found/i);
  } finally {
    if (previousHome === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = previousHome;
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
