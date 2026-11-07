import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { KimiProviderAuth, invalidateKimiAuthStatusCache } from '@/modules/providers/list/kimi/kimi-auth.provider.js';
import { KimiMcpProvider } from '@/modules/providers/list/kimi/kimi-mcp.provider.js';
import { KimiProviderModels } from '@/modules/providers/list/kimi/kimi-models.provider.js';
import { KimiSkillsProvider } from '@/modules/providers/list/kimi/kimi-skills.provider.js';
import {
  buildHistoryMessages,
  KimiSessionsProvider,
  normalizeKimiSessionUpdate,
} from '@/modules/providers/list/kimi/kimi-sessions.provider.js';

const TEST_SESSION_ID = 'session_00000000-0000-4000-8000-000000000001';

test('Kimi history uses wire fallback only after ACP fails', async () => {
  const calls: string[] = [];
  const fallbackMessage = buildHistoryMessages([
    { sessionUpdate: 'agent_message_chunk', messageId: 'a1', content: { type: 'text', text: 'recovered' } },
  ] as never, TEST_SESSION_ID, 1700000000000)[0];
  assert.ok(fallbackMessage);
  const provider = new KimiSessionsProvider({
    loadAcpHistory: async () => { calls.push('acp'); throw new Error('ACP failed'); },
    loadWireHistory: async () => { calls.push('wire'); return [fallbackMessage]; },
  });
  const result = await provider.fetchHistory(TEST_SESSION_ID, { limit: 20, offset: 0 });
  assert.deepEqual(calls, ['acp', 'wire']);
  assert.equal(result.total, 1);
  assert.equal(result.messages[0]?.content, 'recovered');

  const healthy = new KimiSessionsProvider({
    loadAcpHistory: async () => [fallbackMessage],
    loadWireHistory: async () => { throw new Error('must not be called'); },
  });
  assert.equal((await healthy.fetchHistory(TEST_SESSION_ID)).total, 1);
});

test('Kimi history propagates the ACP error when wire fallback also fails', async () => {
  const provider = new KimiSessionsProvider({
    loadAcpHistory: async () => { throw new Error('ACP failed'); },
    loadWireHistory: async () => { throw new Error('wire failed'); },
  });
  await assert.rejects(provider.fetchHistory(TEST_SESSION_ID), /ACP failed/);
});

test('Kimi history does not turn a failed replay with empty fallback into an empty session', async () => {
  const provider = new KimiSessionsProvider({
    loadAcpHistory: async () => { throw new Error('ACP failed'); },
    loadWireHistory: async () => [],
  });
  await assert.rejects(provider.fetchHistory(TEST_SESSION_ID), /ACP failed/);
});

const withKimiHome = async (
  runTest: (context: { home: string; workspace: string }) => Promise<void>,
): Promise<void> => {
  const previousHome = process.env.KIMI_CODE_HOME;
  const previousCliPath = process.env.KIMI_CLI_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'kimi-provider-'));
  const home = path.join(tempDirectory, 'kimi-home');
  const workspace = path.join(tempDirectory, 'workspace');
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });
  process.env.KIMI_CODE_HOME = home;
  invalidateKimiAuthStatusCache();

  try {
    await runTest({ home, workspace });
  } finally {
    invalidateKimiAuthStatusCache();
    if (previousHome === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = previousHome;
    if (previousCliPath === undefined) delete process.env.KIMI_CLI_PATH;
    else process.env.KIMI_CLI_PATH = previousCliPath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
};

const CONFIG_TOML = `default_model = "kimi-code/k3.1-pro"

[models."kimi-code/k3.1-pro"]
provider = "managed:kimi-code"
model = "k3.1-pro"
max_context_size = 1048576
capabilities = ["thinking", "image_in"]
display_name = "K3.1 Pro"
support_efforts = ["low", "high", "max"]
default_effort = "high"

[models."kimi-code/k2"]
provider = "managed:kimi-code"
model = "k2"
max_context_size = 262144
display_name = "K2"
`;

test('the model catalog mirrors config.toml without exposing provider secrets', { concurrency: false }, async () => {
  await withKimiHome(async ({ home }) => {
    await writeFile(path.join(home, 'config.toml'), `${CONFIG_TOML}
[providers."managed:kimi-code"]
api_key = "sk-secret"
`, 'utf8');

    const models = await new KimiProviderModels().getSupportedModels();
    assert.equal(models.DEFAULT, 'kimi-code/k3.1-pro');
    assert.equal(models.OPTIONS.length, 2);

    const pro = models.OPTIONS.find((option) => option.value === 'kimi-code/k3.1-pro');
    assert.equal(pro?.label, 'K3.1 Pro');
    assert.deepEqual(pro?.effort, {
      default: 'high',
      values: [{ value: 'low' }, { value: 'high' }, { value: 'max' }],
    });
    assert.doesNotMatch(JSON.stringify(models), /sk-secret/);
  });
});

test('a missing or malformed config.toml yields an empty catalog, not a crash', { concurrency: false }, async () => {
  await withKimiHome(async ({ home }) => {
    assert.deepEqual(await new KimiProviderModels().getSupportedModels(), { OPTIONS: [], DEFAULT: '' });

    await writeFile(path.join(home, 'config.toml'), 'not = [valid', 'utf8');
    assert.deepEqual(await new KimiProviderModels().getSupportedModels(), { OPTIONS: [], DEFAULT: '' });
  });
});

test('MCP servers round-trip through Kimi mcp.json and keep unknown fields', { concurrency: false }, async () => {
  await withKimiHome(async ({ home, workspace }) => {
    const mcp = new KimiMcpProvider();

    await mcp.upsertServer({
      name: 'local-tool',
      scope: 'user',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: { TOKEN: 'abc' },
    });
    await mcp.upsertServer({
      name: 'remote-tool',
      scope: 'project',
      transport: 'sse',
      url: 'https://example.test/sse',
      workspacePath: workspace,
    });

    const userServers = await mcp.listServersForScope('user');
    assert.equal(userServers.length, 1);
    assert.equal(userServers[0].transport, 'stdio');
    assert.equal(userServers[0].command, 'node');
    assert.deepEqual(userServers[0].env, { TOKEN: 'abc' });

    const projectServers = await mcp.listServersForScope('project', { workspacePath: workspace });
    assert.equal(projectServers[0].transport, 'sse');

    // An edit preserves fields the form does not model (timeouts, tool toggles).
    await writeFile(
      path.join(home, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          'local-tool': { command: 'node', args: ['server.js'], timeoutMs: 5000, tools: { allow: ['x'] } },
        },
      }),
      'utf8',
    );
    await mcp.upsertServer({ name: 'local-tool', scope: 'user', transport: 'stdio', command: 'node', args: ['new.js'] });
    const raw = JSON.parse(await readFile(path.join(home, 'mcp.json'), 'utf8'));
    assert.equal(raw.mcpServers['local-tool'].timeoutMs, 5000);
    assert.deepEqual(raw.mcpServers['local-tool'].tools, { allow: ['x'] });
    assert.deepEqual(raw.mcpServers['local-tool'].args, ['new.js']);
  });
});

test('skills come from both layouts with project > user precedence', { concurrency: false }, async () => {
  await withKimiHome(async ({ home, workspace }) => {
    await mkdir(path.join(workspace, '.git'), { recursive: true });
    await mkdir(path.join(workspace, '.kimi-code', 'skills', 'review'), { recursive: true });
    await writeFile(
      path.join(workspace, '.kimi-code', 'skills', 'review', 'SKILL.md'),
      '---\nname: review\ndescription: project review\n---\n',
      'utf8',
    );
    await mkdir(path.join(workspace, '.kimi-code', 'skills', 'alpha'), { recursive: true });
    await writeFile(
      path.join(workspace, '.kimi-code', 'skills', 'alpha', 'SKILL.md'),
      '---\nname: alpha\ndescription: project alpha\n---\n',
      'utf8',
    );

    await mkdir(path.join(home, 'skills', 'alpha'), { recursive: true });
    await writeFile(
      path.join(home, 'skills', 'alpha', 'SKILL.md'),
      '---\nname: alpha\ndescription: user alpha\n---\n',
      'utf8',
    );
    await writeFile(
      path.join(home, 'skills', 'flat.md'),
      '---\nname: flat\ndescription: flat skill\n---\n',
      'utf8',
    );

    const extraDirectory = path.join(home, 'extra-skills');
    await mkdir(extraDirectory, { recursive: true });
    await writeFile(path.join(extraDirectory, 'extra.md'), '---\nname: extra\ndescription: extra skill\n---\n', 'utf8');
    await writeFile(
      path.join(home, 'config.toml'),
      `extra_skill_dirs = ["${extraDirectory}"]\n`,
      'utf8',
    );

    const skills = await new KimiSkillsProvider().listSkills({ workspacePath: workspace });
    const byName = new Map(skills.map((skill) => [skill.name, skill]));

    // The shared `~/.agents/skills` source is the real home directory and may
    // hold the developer's own skills, so only the fixture names are asserted.
    for (const name of ['alpha', 'extra', 'flat', 'review']) {
      assert.ok(byName.has(name), `missing skill ${name}`);
    }
    assert.equal(byName.get('alpha')?.scope, 'project');
    assert.equal(byName.get('alpha')?.command, '/skill:alpha');
    assert.equal(byName.get('flat')?.command, '/skill:flat');
    assert.equal(byName.get('extra')?.sourcePath, path.join(extraDirectory, 'extra.md'));
  });
});

test('a missing CLI reports not-installed instead of not-authenticated', { concurrency: false }, async () => {
  await withKimiHome(async ({ home }) => {
    void home;
    process.env.KIMI_CLI_PATH = '/nonexistent/kimi-binary';
    invalidateKimiAuthStatusCache();

    const status = await new KimiProviderAuth().getStatus();
    assert.equal(status.installed, false);
    assert.equal(status.authenticated, false);
    assert.match(status.error ?? '', /not installed|not on PATH/i);
  });
});

test('tool call updates attach to the same tool id and plans become checklist rows', () => {
  const toolUse = normalizeKimiSessionUpdate({
    sessionUpdate: 'tool_call',
    toolCallId: 'tc-1',
    title: 'Read file',
    name: 'Read',
    status: 'in_progress',
    rawInput: { path: 'a.ts' },
  } as never, { sessionId: 'app-1', historical: false, sequence: 0 });
  assert.equal(toolUse[0].kind, 'tool_use');
  assert.equal(toolUse[0].toolId, 'tc-1');
  assert.equal(toolUse[0].id, 'kimi_tool_tc-1');

  const progress = normalizeKimiSessionUpdate({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tc-1',
    status: 'in_progress',
  } as never, { sessionId: 'app-1', historical: false, sequence: 1 });
  assert.deepEqual(progress, []);

  const finished = normalizeKimiSessionUpdate({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tc-1',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: 'file body' } }],
  } as never, { sessionId: 'app-1', historical: false, sequence: 2 });
  assert.equal(finished[0].kind, 'tool_result');
  assert.equal(finished[0].toolId, 'tc-1');
  assert.equal(finished[0].content, 'file body');

  const plan = normalizeKimiSessionUpdate({
    sessionUpdate: 'plan',
    entries: [
      { content: 'first', status: 'completed', priority: 'high' },
      { content: 'second', status: 'in_progress', priority: 'medium' },
    ],
  } as never, { sessionId: 'app-1', historical: false, sequence: 3 });
  assert.equal(plan[0].toolName, 'TodoWrite');
  assert.deepEqual(plan[0].toolInput, {
    todos: [
      { content: 'first', status: 'completed', priority: 'high' },
      { content: 'second', status: 'in_progress', priority: 'medium' },
    ],
  });
});

test('history replay folds chunks into complete rows in order', () => {
  const anchor = 1_700_000_000_000;
  const messages = buildHistoryMessages([
    { sessionUpdate: 'user_message_chunk', messageId: 'u1', content: { type: 'text', text: 'hi' } },
    { sessionUpdate: 'user_message_chunk', messageId: 'u0', content: { type: 'text', text: '<system-reminder>ignore me</system-reminder>' } },
    { sessionUpdate: 'agent_thought_chunk', messageId: 't1', content: { type: 'text', text: 'think ' } },
    { sessionUpdate: 'agent_thought_chunk', messageId: 't1', content: { type: 'text', text: 'more' } },
    { sessionUpdate: 'agent_message_chunk', messageId: 'a1', content: { type: 'text', text: 'he' } },
    { sessionUpdate: 'agent_message_chunk', messageId: 'a1', content: { type: 'text', text: 'llo' } },
    { sessionUpdate: 'tool_call', toolCallId: 'tc', title: 'Bash', name: 'Bash', status: 'completed' },
  ] as never, 'session_fake', anchor);

  assert.deepEqual(messages.map((message) => message.kind), ['text', 'thinking', 'text', 'tool_use']);
  assert.deepEqual(messages.map((message) => message.content), ['hi', 'think more', 'hello', undefined]);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[2].role, 'assistant');
  assert.equal(new Set(messages.map((message) => message.id)).size, messages.length);

  // Synthetic timestamps are anchored to the session's real last update, so
  // history rows never sort below the live turn.
  const times = messages.map((message) => Date.parse(message.timestamp));
  assert.ok(times.every((time) => Number.isFinite(time)));
  assert.deepEqual([...times].sort((left, right) => left - right), times);
  assert.ok(times[times.length - 1] <= anchor);
});