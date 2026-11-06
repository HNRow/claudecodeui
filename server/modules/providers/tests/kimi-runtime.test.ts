import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeKimiRuntime, kimiRuntime, resolveKimiPermissionMode } from '@/modules/providers/list/kimi/kimi-runtime.provider.js';
import { KimiSessionsProvider } from '@/modules/providers/list/kimi/kimi-sessions.provider.js';
import type { NormalizedMessage, ProviderRuntimeContext, ProviderRuntimeWriter } from '@/shared/types.js';

/**
 * Minimal ACP agent used to drive the client without a real model.
 *
 * It speaks the same NDJSON JSON-RPC dialect `kimi acp` does and switches
 * behaviour with FAKE_KIMI_SCENARIO. Every inbound method is appended to
 * FAKE_KIMI_LOG so ordering claims can be checked.
 */
const FAKE_KIMI_SCRIPT = `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');

const scenario = process.env.FAKE_KIMI_SCENARIO || 'text';
const logPath = process.env.FAKE_KIMI_LOG || '';
const log = (line) => { if (logPath) fs.appendFileSync(logPath, line + '\\n'); };
let nextId = 1000;
let cancelled = false;
let pendingPrompt = null;

const write = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const respond = (id, result) => write({ jsonrpc: '2.0', id, result });
const notify = (method, params) => write({ jsonrpc: '2.0', method, params });

const configOptions = [
  { type: 'select', id: 'model', name: 'Model', category: 'model', currentValue: 'kimi-code/fake',
    options: [{ value: 'kimi-code/fake', name: 'Fake' }, { value: 'kimi-code/other', name: 'Other' }] },
  { type: 'select', id: 'thinking', name: 'Thinking', category: 'thought_level', currentValue: 'high',
    options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
  { type: 'select', id: 'mode', name: 'Mode', category: 'mode', currentValue: 'default',
    options: [{ value: 'default', name: 'Default' }] },
];
const modes = {
  currentModeId: 'default',
  availableModes: [
    { id: 'default', name: 'Default' },
    { id: 'yolo', name: 'YOLO' },
    { id: 'auto', name: 'Auto' },
    { id: 'plan', name: 'Plan' },
  ],
};

const sessionId = 'session_fake-0000-1111-2222-333333333333';

async function runPrompt(id) {
  if (scenario === 'permission') {
    const optionId = await new Promise((resolve) => {
      pendingPrompt = (value) => resolve(value);
      const requestId = nextId++;
      write({ jsonrpc: '2.0', id: requestId, method: 'session/request_permission', params: {
        sessionId,
        toolCall: { toolCallId: 'tc1', title: 'Write file', name: 'Write', kind: 'edit', rawInput: { path: 'x.txt' } },
        options: [
          { optionId: 'allow-id', name: 'Allow', kind: 'allow_once' },
          { optionId: 'reject-id', name: 'Reject', kind: 'reject_once' },
        ],
      } });
    });
    notify('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'chosen:' + optionId } } });
    respond(id, { stopReason: 'end_turn' });
    return;
  }

  if (scenario === 'slow') {
    pendingPrompt = () => { respond(id, { stopReason: 'cancelled' }); };
    return;
  }

  notify('session/update', { sessionId, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking...' } } });
  notify('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hel' } } });
  notify('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'lo' } } });
  respond(id, { stopReason: 'end_turn' });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }

  if (message.method === undefined) {
    // Response to our permission request.
    if (pendingPrompt) { const resolve = pendingPrompt; pendingPrompt = null; resolve(message.result?.outcome?.optionId ?? 'none'); }
    return;
  }

  log(message.method);
  if (message.method === 'session/cancel') {
    cancelled = true;
    if (pendingPrompt) { const resolve = pendingPrompt; pendingPrompt = null; resolve(); }
    return;
  }

  if (message.id === undefined) {
    return;
  }

  switch (message.method) {
    case 'initialize':
      respond(message.id, { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] });
      break;
    case 'session/new':
      respond(message.id, { sessionId, configOptions, modes });
      break;
    case 'session/resume':
      respond(message.id, { configOptions, modes });
      break;
    case 'session/set_config_option':
      respond(message.id, { configOptions });
      break;
    case 'session/set_mode':
      respond(message.id, {});
      break;
    case 'session/close':
      respond(message.id, {});
      break;
    case 'session/prompt':
      await runPrompt(message.id);
      break;
    default:
      respond(message.id, {});
  }
});
void cancelled;
`;

type RuntimeHarness = {
  messages: NormalizedMessage[];
  providerSessionIds: string[];
  run: () => Promise<void>;
  context: ProviderRuntimeContext;
  writer: ProviderRuntimeWriter;
};

async function createHarness(
  scenario: string,
  options: Record<string, unknown> = {},
): Promise<{ harness: RuntimeHarness; logPath: string; cleanup: () => Promise<void> }> {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'kimi-runtime-'));
  const cliPath = path.join(tempDirectory, 'fake-kimi.cjs');
  const logPath = path.join(tempDirectory, 'calls.log');
  await writeFile(cliPath, FAKE_KIMI_SCRIPT, 'utf8');
  await chmod(cliPath, 0o755);

  const previousCliPath = process.env.KIMI_CLI_PATH;
  const previousScenario = process.env.FAKE_KIMI_SCENARIO;
  const previousLog = process.env.FAKE_KIMI_LOG;
  process.env.KIMI_CLI_PATH = cliPath;
  process.env.FAKE_KIMI_SCENARIO = scenario;
  process.env.FAKE_KIMI_LOG = logPath;

  const sessions = new KimiSessionsProvider();
  const messages: NormalizedMessage[] = [];
  const providerSessionIds: string[] = [];
  const writer: ProviderRuntimeWriter = {
    send: (message) => {
      messages.push(message as NormalizedMessage);
    },
    setSessionId: (sessionId) => {
      providerSessionIds.push(sessionId);
    },
    userId: 1,
  };
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => ({ OPTIONS: [], DEFAULT: '' }),
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
  };

  return {
    harness: {
      messages,
      providerSessionIds,
      context,
      writer,
      run: async () => {
        await kimiRuntime.run('hello', {
          sessionId: `app-${scenario}`,
          cwd: tempDirectory,
          permissionMode: 'default',
          ...options,
        }, writer, context);
      },
    },
    logPath,
    cleanup: async () => {
      if (previousCliPath === undefined) delete process.env.KIMI_CLI_PATH;
      else process.env.KIMI_CLI_PATH = previousCliPath;
      if (previousScenario === undefined) delete process.env.FAKE_KIMI_SCENARIO;
      else process.env.FAKE_KIMI_SCENARIO = previousScenario;
      if (previousLog === undefined) delete process.env.FAKE_KIMI_LOG;
      else process.env.FAKE_KIMI_LOG = previousLog;
      await rm(tempDirectory, { recursive: true, force: true });
    },
  };
}

const readLog = async (logPath: string): Promise<string[]> => {
  try {
    return (await readFile(logPath, 'utf8')).trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
};

/** Waits until the fake agent logged one method, so timing is not guessed. */
const waitForLog = async (logPath: string, method: string, timeoutMs = 8_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await readLog(logPath)).includes(method)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for the fake agent to receive ${method}.`);
};

/** Waits for a kind to appear instead of guessing a fixed delay. */
const waitForMessage = async (
  messages: NormalizedMessage[],
  kind: NormalizedMessage['kind'],
  timeoutMs = 8_000,
): Promise<NormalizedMessage> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = messages.find((message) => message.kind === kind);
    if (match) {
      return match;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for a ${kind} message.`);
};

test('a turn announces the session, streams text, and completes', { concurrency: false }, async () => {
  const { harness, cleanup } = await createHarness('text');
  try {
    await harness.run();

    assert.deepEqual(harness.providerSessionIds, ['session_fake-0000-1111-2222-333333333333']);
    const kinds = harness.messages.map((message) => message.kind);
    assert.ok(kinds.includes('session_created'));
    assert.ok(kinds.includes('thinking'));
    assert.equal(harness.messages.filter((message) => message.kind === 'stream_delta').length, 2);
    assert.ok(kinds.includes('stream_end'));
    const complete = harness.messages.find((message) => message.kind === 'complete');
    assert.equal(complete?.success, true);
    assert.equal(kinds[kinds.length - 1] === 'status' || kinds[kinds.length - 1] === 'complete', true);
  } finally {
    await cleanup();
  }
});

test('a permission request reaches the UI and the chosen kind is returned', { concurrency: false }, async () => {
  const { harness, cleanup } = await createHarness('permission', { sessionId: 'app-permission-allow' });
  let running: Promise<void> | null = null;
  try {
    running = harness.run();
    const request = await waitForMessage(harness.messages, 'permission_request');
    assert.equal(request.toolName, 'Write');

    kimiRuntime.permissions?.resolve(request.requestId as string, { allow: true });
    await running;

    assert.ok(harness.messages.some((message) => message.kind === 'permission_resolved'));
    const streamed = harness.messages
      .filter((message) => message.kind === 'stream_delta')
      .map((message) => message.content)
      .join('');
    assert.equal(streamed, 'chosen:allow-id');
  } finally {
    if (running) {
      await Promise.resolve(kimiRuntime.abort('app-permission-allow')).catch(() => undefined);
      await running.catch(() => undefined);
    }
    await cleanup();
  }
});

test('a denied request selects a reject option', { concurrency: false }, async () => {
  const { harness, cleanup } = await createHarness('permission', { sessionId: 'app-permission-deny' });
  let running: Promise<void> | null = null;
  try {
    running = harness.run();
    const request = await waitForMessage(harness.messages, 'permission_request');
    kimiRuntime.permissions?.resolve(request.requestId as string, { allow: false });
    await running;

    const streamed = harness.messages
      .filter((message) => message.kind === 'stream_delta')
      .map((message) => message.content)
      .join('');
    assert.equal(streamed, 'chosen:reject-id');
  } finally {
    if (running) {
      await Promise.resolve(kimiRuntime.abort('app-permission-deny')).catch(() => undefined);
      await running.catch(() => undefined);
    }
    await cleanup();
  }
});

test('abort cancels the ACP turn instead of killing it first', { concurrency: false }, async () => {
  const { harness, logPath, cleanup } = await createHarness('slow', { sessionId: 'app-slow' });
  try {
    const running = harness.run();
    await waitForLog(logPath, 'session/prompt');
    const aborted = await kimiRuntime.abort('app-slow');
    assert.equal(aborted, true);
    await running;

    const calls = await readLog(logPath);
    assert.ok(calls.includes('session/cancel'));
    // An aborted turn leaves the terminal complete to the caller, never emits its own.
    assert.equal(harness.messages.some((message) => message.kind === 'complete'), false);
  } finally {
    await cleanup();
  }
});

test('a second run for the same session is refused', { concurrency: false }, async () => {
  const { harness, cleanup } = await createHarness('slow', { sessionId: 'app-slow-double' });
  try {
    const running = harness.run();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await assert.rejects(harness.run(), /already running/);
    await kimiRuntime.abort('app-slow-double');
    await running;
  } finally {
    await cleanup();
  }
});

test('backend shutdown stops every live ACP turn', { concurrency: false }, async () => {
  const { harness, logPath, cleanup } = await createHarness('slow', { sessionId: 'app-shutdown' });
  try {
    const running = harness.run();
    await waitForLog(logPath, 'session/prompt');
    await closeKimiRuntime();
    await running;
    assert.equal(harness.messages.some((message) => message.kind === 'complete'), false);
  } finally {
    await cleanup();
  }
});

test('permission modes resolve against the advertised ids', () => {
  const modes = {
    currentModeId: 'default',
    availableModes: [
      { id: 'default', name: 'Default' },
      { id: 'yolo', name: 'YOLO' },
      { id: 'auto', name: 'Auto' },
      { id: 'plan', name: 'Plan' },
    ],
  };

  assert.equal(resolveKimiPermissionMode(modes, 'default'), 'default');
  assert.equal(resolveKimiPermissionMode(modes, 'acceptEdits'), 'yolo');
  assert.equal(resolveKimiPermissionMode(modes, 'bypassPermissions'), 'auto');
  assert.equal(resolveKimiPermissionMode(modes, 'plan'), 'plan');
  assert.throws(
    () => resolveKimiPermissionMode({ currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }] }, 'plan'),
    /plan mode/,
  );
});