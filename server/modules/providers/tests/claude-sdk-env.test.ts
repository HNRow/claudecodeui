import assert from 'node:assert/strict';
import test from 'node:test';

import { buildClaudeSdkEnv } from '@/modules/providers/list/claude/claude-runtime.provider.js';

// Claude Code turns the Artifact tools off for SDK-driven sessions unless
// CLAUDE_CODE_ARTIFACT is set, so a UI session would lose them mid-conversation.
test('SDK sessions opt into the Artifact tools by default', () => {
  assert.equal(buildClaudeSdkEnv({}).CLAUDE_CODE_ARTIFACT, '1');
});

test('a host CLAUDE_CODE_ARTIFACT value wins over the default', () => {
  assert.equal(buildClaudeSdkEnv({ CLAUDE_CODE_ARTIFACT: '0' }).CLAUDE_CODE_ARTIFACT, '0');
});

test('SDK sessions are labeled claudecodeui, and a host value wins', () => {
  assert.equal(buildClaudeSdkEnv({}).CLAUDE_CODE_ENTRYPOINT, 'claudecodeui');
  assert.equal(buildClaudeSdkEnv({ CLAUDE_CODE_ENTRYPOINT: 'x' }).CLAUDE_CODE_ENTRYPOINT, 'x');
});

test('host env vars are still forwarded', () => {
  assert.equal(buildClaudeSdkEnv({ ANTHROPIC_BASE_URL: 'http://proxy' }).ANTHROPIC_BASE_URL, 'http://proxy');
});

test('a per-model endpoint overrides the host gateway and token', () => {
  const env = buildClaudeSdkEnv(
    {
      ANTHROPIC_BASE_URL: 'http://host-gateway',
      ANTHROPIC_AUTH_TOKEN: 'host-token',
      ANTHROPIC_API_KEY: 'host-key',
      ANTHROPIC_MODEL: 'host-model',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'host-opus',
    },
    { baseUrl: 'http://10.0.0.6:8000', apiKey: 'local-token' },
  );

  assert.equal(env.ANTHROPIC_BASE_URL, 'http://10.0.0.6:8000');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'local-token');
  // The host's alias defaults would route the custom id back to the host provider.
  assert.equal(env.ANTHROPIC_MODEL, undefined);
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
});

test('a per-model endpoint without a token keeps the host credentials', () => {
  const env = buildClaudeSdkEnv(
    { ANTHROPIC_AUTH_TOKEN: 'host-token' },
    { baseUrl: 'http://10.0.0.6:8000', apiKey: null },
  );

  assert.equal(env.ANTHROPIC_BASE_URL, 'http://10.0.0.6:8000');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'host-token');
});
