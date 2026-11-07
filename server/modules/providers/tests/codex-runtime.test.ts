import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { Codex } from '@openai/codex-sdk';
import type { Thread, ThreadOptions } from '@openai/codex-sdk';

import { codexRuntime } from '@/modules/providers/list/codex/codex-runtime.provider.js';
import type { ProviderRuntimeContext } from '@/shared/index.js';
import { CODEX_THREAD_ID, codexLifecycle, withCodexCliFixture } from '@/modules/providers/tests/codex-cli.fixture.js';

for (const resumed of [false, true]) {
  for (const permissionMode of [undefined, 'default', 'unknown', 'acceptEdits', 'bypassPermissions']) {
    test(`Codex ${resumed ? 'resumes' : 'starts'} with supported permissions (${permissionMode ?? 'omitted'})`, async (t) => {
      let capturedOptions: ThreadOptions | undefined;
      let capturedPrompt: unknown;
      const messages: unknown[] = [];
      const thread = {
        id: 'native-thread',
        async runStreamed(prompt: unknown) {
          capturedPrompt = prompt;
          return { events: (async function* () {
            yield { type: 'thread.started', thread_id: 'native-thread' };
          })() };
        },
      } as unknown as Thread;

      const start = t.mock.method(Codex.prototype, 'startThread', (options?: ThreadOptions) => {
        capturedOptions = options;
        return thread;
      });
      const resume = t.mock.method(Codex.prototype, 'resumeThread', (id: string, options?: ThreadOptions) => {
        assert.equal(id, 'native-thread');
        capturedOptions = options;
        return thread;
      });
      const context: ProviderRuntimeContext = {
        resolveProviderSessionId: () => resumed ? 'native-thread' : null,
        resolveResumeModel: async () => 'test-model',
        getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'test-model' }),
        normalizeMessage: () => [],
        isProviderInstalled: async () => true,
      };

      await codexRuntime.run('hey there', {
        sessionId: resumed ? 'app-session' : undefined,
        permissionMode,
        cwd: process.cwd(),
      }, { isWebSocketWriter: true, send: (message) => messages.push(message) }, context);

      assert.equal(start.mock.callCount(), resumed ? 0 : 1);
      assert.equal(resume.mock.callCount(), resumed ? 1 : 0);
      assert.equal(capturedPrompt, 'hey there');
      assert.equal(capturedOptions?.sandboxMode, permissionMode === 'bypassPermissions' ? 'danger-full-access' : 'workspace-write');
      assert.equal(capturedOptions?.approvalPolicy, permissionMode === 'acceptEdits' || permissionMode === 'bypassPermissions' ? 'never' : 'on-request');
      assert.ok(messages.some((message: any) => message.kind === 'complete' && message.exitCode === 0));
      assert.ok(!messages.some((message: any) => message.kind === 'error'));
    });
  }
}

for (const completed of [false, true]) {
  test(`Codex refuses a live external writer before starting exec (completed=${completed})`, async (t) => {
    await withCodexCliFixture(async ({ stopHolder }) => {
      const messages: any[] = [];
      const resume = t.mock.method(Codex.prototype, 'resumeThread', () => {
        throw new Error('exec must not start while an external writer holds the lock');
      });
      const context: ProviderRuntimeContext = {
        resolveProviderSessionId: () => CODEX_THREAD_ID,
        resolveResumeModel: async () => 'test-model',
        getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'test-model' }),
        normalizeMessage: () => [],
        isProviderInstalled: async () => true,
      };
      await codexRuntime.run('commit + push', { sessionId: 'app-conflict', cwd: process.cwd() },
        { isWebSocketWriter: true, send: message => messages.push(message) }, context);
      assert.equal(resume.mock.callCount(), 0);
      const error = messages.find(message => message.kind === 'error');
      assert.match(error?.content ?? '', /another Codex client/i);
      assert.match(error.content, /fork/i);
      assert.ok(messages.some(message => message.kind === 'complete' && message.exitCode === 1));
      await stopHolder();
      const thread = { id: CODEX_THREAD_ID, runStreamed: async () => ({ events: (async function* () {})() }) } as unknown as Thread;
      resume.mock.restore();
      const retry = t.mock.method(Codex.prototype, 'resumeThread', () => thread);
      messages.length = 0;
      await codexRuntime.run('commit + push', { sessionId: 'app-conflict', cwd: process.cwd() },
        { isWebSocketWriter: true, send: message => messages.push(message) }, context);
      assert.equal(retry.mock.callCount(), 1, 'a stale lock file does not prevent resuming after the holder exits');
      assert.ok(messages.some(message => message.kind === 'complete' && message.exitCode === 0));
    }, { lines: [codexLifecycle(completed ? 'task_complete' : 'task_started')] });
  });
}

test('a writer acquired after preflight produces an actionable error instead of raw Codex stderr', async (t) => {
  const rawError = 'Codex Exec exited with code 1: Reading prompt from stdin...\nthread-store conflict: thread native-thread already has an active writer';
  const thread = { runStreamed: async () => { throw new Error(rawError); } } as unknown as Thread;
  t.mock.method(Codex.prototype, 'resumeThread', () => thread);
  const messages: any[] = [];
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => 'native-thread',
    resolveResumeModel: async () => 'test-model',
    getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'test-model' }),
    normalizeMessage: () => [],
    isProviderInstalled: async () => true,
  };
  await codexRuntime.run('commit + push', { sessionId: 'app-race' },
    { isWebSocketWriter: true, send: message => messages.push(message) }, context);
  const error = messages.find(message => message.kind === 'error');
  assert.match(error?.content ?? '', /another Codex client/i);
  assert.equal(error.content.includes('Reading prompt from stdin'), false);
  assert.ok(messages.some(message => message.kind === 'complete' && message.exitCode === 1));
});

test('a prior aborted run cannot swallow a new request blocked by an external writer', async (t) => {
  const appSessionId = 'app-aborted-writer';
  const messages: any[] = [];
  const thread = {
    runStreamed: async () => ({ events: (async function* () {
      codexRuntime.abort(appSessionId);
      yield { type: 'turn.started' };
    })() }),
  } as unknown as Thread;
  const resume = t.mock.method(Codex.prototype, 'resumeThread', () => thread);
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => CODEX_THREAD_ID,
    resolveResumeModel: async () => 'test-model',
    getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'test-model' }),
    normalizeMessage: () => [],
    isProviderInstalled: async () => true,
  };
  const writer = { isWebSocketWriter: true, send: (message: unknown) => messages.push(message) };
  await withCodexCliFixture(async () => {
    await codexRuntime.run('first turn', { sessionId: appSessionId }, writer, context);
  }, { held: false });
  messages.length = 0;
  await withCodexCliFixture(async () => {
    await codexRuntime.run('commit + push', { sessionId: appSessionId }, writer, context);
    assert.equal(resume.mock.callCount(), 1, 'only the initial, cancelled run starts an SDK thread');
    assert.ok(messages.some(message => message.kind === 'error' && /another Codex client/i.test(message.content)));
    assert.ok(messages.some(message => message.kind === 'complete' && message.exitCode === 1));
  });
});

for (const command of ['', '  \n\t']) {
  test(`Codex supplies a prompt for an image-only turn (${JSON.stringify(command)})`, async (t) => {
    let capturedPrompt: unknown;
    const imagePath = path.join(process.cwd(), 'public', 'favicon.png');
    const thread = {
      id: 'native-thread',
      async runStreamed(prompt: unknown) {
        capturedPrompt = prompt;
        return { events: (async function* () {
          yield { type: 'thread.started', thread_id: 'native-thread' };
        })() };
      },
    } as unknown as Thread;

    t.mock.method(Codex.prototype, 'startThread', () => thread);
    const context: ProviderRuntimeContext = {
      resolveProviderSessionId: () => null,
      resolveResumeModel: async () => 'test-model',
      getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'test-model' }),
      normalizeMessage: () => [],
      isProviderInstalled: async () => true,
    };

    await codexRuntime.run(command, {
      cwd: process.cwd(),
      images: [{ path: imagePath, mimeType: 'image/png' }],
    }, { isWebSocketWriter: true, send: () => {} }, context);

    assert.deepEqual(capturedPrompt, [
      { type: 'text', text: 'Please analyze the attached image(s).' },
      { type: 'local_image', path: imagePath },
    ]);
  });
}
