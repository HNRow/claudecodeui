import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ClaudeProviderAuth } from '@/modules/providers/list/claude/claude-auth.provider.js';
import type { ProviderAuthStatus, ProviderAuthSubscriptionOverride } from '@/shared/types.js';

// Test credentials independently of CLI installation. Inject a Keychain reader
// so temporary-home fixtures never access the real macOS login Keychain.
type CheckCredentialsResult = {
  authenticated: boolean;
  email: string | null;
  method: string | null;
  error?: string;
  subscriptionOverride?: ProviderAuthSubscriptionOverride;
};

/** Exercises credential priority without invoking the installed CLI. */
const checkCredentials = (auth: ClaudeProviderAuth): Promise<CheckCredentialsResult> =>
  (auth as unknown as { checkCredentials: () => Promise<CheckCredentialsResult> }).checkCredentials();

// getStatus() is the public API the route serves, but it first shells out to
// `claude --version`. Stubbing checkInstalled() lets the test cover the mapping
// from checkCredentials() to the wire shape without the CLI.
/** Checks the public response while isolating CLI installation probing. */
const getStatusWithCliInstalled = (auth: ClaudeProviderAuth): Promise<ProviderAuthStatus> => {
  auth.checkInstalled = () => ({ installed: true, exitCode: 0, version: '2.1.0' });
  return auth.getStatus();
};

/** Creates a usable subscription fixture with an optional account label. */
const validSubscriptionCredentials = (email?: string) => ({
  claudeAiOauth: {
    accessToken: 'valid-token',
    refreshToken: 'live-refresh-token',
    expiresAt: Date.now() + 60 * 60 * 1000,
  },
  ...(email ? { email } : {}),
});

const ENV_KEYS = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CONFIG_DIR'] as const;

/** Isolates credential environment variables and restores them after every fixture. */
const withEnv = async (
  overrides: Partial<Record<(typeof ENV_KEYS)[number], string>>,
  fn: () => Promise<void>,
) => {
  const original: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
  for (const key of ENV_KEYS) {
    original[key] = process.env[key];
    const value = overrides[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    await fn();
  } finally {
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original[key];
      }
    }
  }
};

/** Isolates file-backed credentials and removes only the temporary test directory. */
const withTempHome = async (fn: (homeDir: string) => Promise<void>) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'claude-auth-test-'));
  const originalHome = process.env.HOME;
  process.env.HOME = homeDir;
  try {
    await fn(homeDir);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await rm(homeDir, { recursive: true, force: true });
  }
};

/** Writes a credential fixture into the isolated default configuration directory. */
const writeCredentialsFile = async (homeDir: string, body: unknown) => {
  const claudeDir = path.join(homeDir, '.claude');
  await mkdir(claudeDir, { recursive: true });
  await writeFile(path.join(claudeDir, '.credentials.json'), JSON.stringify(body));
};

/** Writes CLI settings without touching the real user configuration. */
const writeSettingsFile = async (homeDir: string, env: Record<string, string>) => {
  const claudeDir = path.join(homeDir, '.claude');
  await mkdir(claudeDir, { recursive: true });
  await writeFile(path.join(claudeDir, 'settings.json'), JSON.stringify({ env }));
};

test('checkCredentials: CLAUDE_CODE_OAUTH_TOKEN set is authenticated via environment, even with a stale credentials file', async () => {
  await withTempHome(async (homeDir) => {
    await writeCredentialsFile(homeDir, {
      claudeAiOauth: { accessToken: 'stale-token', expiresAt: 1_000_000_000_000 }, // long expired
    });

    await withEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'test-oauth-token' }, async () => {
      const status = await checkCredentials(new ClaudeProviderAuth(async () => null));
      assert.equal(status.authenticated, true);
      assert.equal(status.method, 'environment');
    });
  });
});

test('checkCredentials: CLAUDE_CODE_OAUTH_TOKEN configured via settings.json env block is authenticated via environment', async () => {
  await withTempHome(async (homeDir) => {
    await writeSettingsFile(homeDir, { CLAUDE_CODE_OAUTH_TOKEN: 'test-oauth-token-from-settings' });
    await writeCredentialsFile(homeDir, {
      claudeAiOauth: { accessToken: 'stale-token', expiresAt: 1_000_000_000_000 }, // long expired
    });

    await withEnv({}, async () => {
      const status = await checkCredentials(new ClaudeProviderAuth(async () => null));
      assert.equal(status.authenticated, true);
      assert.equal(status.method, 'environment');
    });
  });
});

test('checkCredentials: no CLAUDE_CODE_OAUTH_TOKEN, valid credentials file falls back to credentials_file', async () => {
  await withTempHome(async (homeDir) => {
    await writeCredentialsFile(homeDir, {
      claudeAiOauth: { accessToken: 'valid-token', expiresAt: Date.now() + 60 * 60 * 1000 },
      email: 'someone@example.com',
    });

    await withEnv({}, async () => {
      const status = await checkCredentials(new ClaudeProviderAuth(async () => null));
      assert.equal(status.authenticated, true);
      assert.equal(status.method, 'credentials_file');
      assert.equal(status.email, 'someone@example.com');
    });
  });
});

test('checkCredentials: no CLAUDE_CODE_OAUTH_TOKEN, expired credentials file reports not authenticated', async () => {
  await withTempHome(async (homeDir) => {
    await writeCredentialsFile(homeDir, {
      claudeAiOauth: { accessToken: 'stale-token', expiresAt: 1_000_000_000_000 },
    });

    await withEnv({}, async () => {
      const status = await checkCredentials(new ClaudeProviderAuth(async () => null));
      assert.equal(status.authenticated, false);
      assert.match(status.error ?? '', /expired/i);
    });
  });
});

test('checkCredentials: expired access token with a live refresh token is still authenticated', async () => {
  await withTempHome(async (homeDir) => {
    await writeCredentialsFile(homeDir, {
      claudeAiOauth: {
        accessToken: 'stale-token',
        refreshToken: 'live-refresh-token',
        expiresAt: 1_000_000_000_000,
        refreshTokenExpiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
      },
      email: 'someone@example.com',
    });

    await withEnv({}, async () => {
      const status = await checkCredentials(new ClaudeProviderAuth(async () => null));
      assert.equal(status.authenticated, true);
      assert.equal(status.method, 'credentials_file');
      assert.equal(status.email, 'someone@example.com');
    });
  });
});

test('checkCredentials: expired access token with a refresh token that has no recorded expiry is authenticated', async () => {
  await withTempHome(async (homeDir) => {
    await writeCredentialsFile(homeDir, {
      claudeAiOauth: {
        accessToken: 'stale-token',
        refreshToken: 'live-refresh-token',
        expiresAt: 1_000_000_000_000,
      },
    });

    await withEnv({}, async () => {
      const status = await checkCredentials(new ClaudeProviderAuth(async () => null));
      assert.equal(status.authenticated, true);
      assert.equal(status.method, 'credentials_file');
    });
  });
});

test('checkCredentials: expired access token with an expired refresh token reports not authenticated', async () => {
  await withTempHome(async (homeDir) => {
    await writeCredentialsFile(homeDir, {
      claudeAiOauth: {
        accessToken: 'stale-token',
        refreshToken: 'stale-refresh-token',
        expiresAt: 1_000_000_000_000,
        refreshTokenExpiresAt: 1_000_000_000_000,
      },
    });

    await withEnv({}, async () => {
      const status = await checkCredentials(new ClaudeProviderAuth(async () => null));
      assert.equal(status.authenticated, false);
      assert.match(status.error ?? '', /expired/i);
    });
  });
});

test('checkCredentials: ANTHROPIC_API_KEY takes precedence over CLAUDE_CODE_OAUTH_TOKEN', async () => {
  await withTempHome(async () => {
    await withEnv(
      { ANTHROPIC_API_KEY: 'test-api-key', CLAUDE_CODE_OAUTH_TOKEN: 'test-oauth-token' },
      async () => {
        const status = await checkCredentials(new ClaudeProviderAuth(async () => null));
        assert.equal(status.authenticated, true);
        assert.equal(status.method, 'api_key');
      },
    );
  });
});

// Issue #568: Claude Code silently prefers ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN
// over the `claude /login` subscription, billing every request to the key. The
// status must say so — and only when a usable login is really being bypassed.

test('checkCredentials: ANTHROPIC_API_KEY in the process env alongside a valid subscription login reports the override', async () => {
  await withTempHome(async (homeDir) => {
    await writeCredentialsFile(homeDir, validSubscriptionCredentials('someone@example.com'));

    await withEnv({ ANTHROPIC_API_KEY: 'test-api-key' }, async () => {
      const status = await checkCredentials(new ClaudeProviderAuth(async () => null));
      // The existing fields are untouched: the key still wins and keeps its label.
      assert.equal(status.authenticated, true);
      assert.equal(status.method, 'api_key');
      assert.equal(status.email, 'API Key Auth');
      assert.deepEqual(status.subscriptionOverride, {
        variable: 'ANTHROPIC_API_KEY',
        source: 'process_env',
        subscriptionEmail: 'someone@example.com',
      });
    });
  });
});

test('checkCredentials: ANTHROPIC_AUTH_TOKEN in the process env alongside a valid subscription login names the auth token', async () => {
  await withTempHome(async (homeDir) => {
    await writeCredentialsFile(homeDir, validSubscriptionCredentials());

    await withEnv({ ANTHROPIC_AUTH_TOKEN: 'test-auth-token', ANTHROPIC_API_KEY: 'test-api-key' }, async () => {
      const status = await checkCredentials(new ClaudeProviderAuth(async () => null));
      assert.equal(status.method, 'api_key');
      assert.equal(status.email, 'Auth Token');
      assert.deepEqual(status.subscriptionOverride, {
        variable: 'ANTHROPIC_AUTH_TOKEN',
        source: 'process_env',
        subscriptionEmail: null,
      });
    });
  });
});

test('checkCredentials: ANTHROPIC_API_KEY in settings.json env alongside a valid subscription login points at settings.json', async () => {
  await withTempHome(async (homeDir) => {
    await writeSettingsFile(homeDir, { ANTHROPIC_API_KEY: 'test-api-key-from-settings' });
    await writeCredentialsFile(homeDir, validSubscriptionCredentials('someone@example.com'));

    await withEnv({}, async () => {
      const status = await checkCredentials(new ClaudeProviderAuth(async () => null));
      assert.equal(status.method, 'api_key');
      assert.equal(status.email, 'API Key Auth');
      assert.deepEqual(status.subscriptionOverride, {
        variable: 'ANTHROPIC_API_KEY',
        source: 'settings_file',
        subscriptionEmail: 'someone@example.com',
      });
    });
  });
});

test('checkCredentials: ANTHROPIC_API_KEY with no credentials file reports no override', async () => {
  await withTempHome(async () => {
    await withEnv({ ANTHROPIC_API_KEY: 'test-api-key' }, async () => {
      const status = await checkCredentials(new ClaudeProviderAuth(async () => null));
      assert.equal(status.authenticated, true);
      assert.equal(status.method, 'api_key');
      assert.equal(status.subscriptionOverride, undefined);
    });
  });
});

test('checkCredentials: ANTHROPIC_API_KEY with an expired subscription login reports no override', async () => {
  await withTempHome(async (homeDir) => {
    // Nothing usable is being bypassed here, so warning would only confuse.
    await writeCredentialsFile(homeDir, {
      claudeAiOauth: {
        accessToken: 'stale-token',
        refreshToken: 'stale-refresh-token',
        expiresAt: 1_000_000_000_000,
        refreshTokenExpiresAt: 1_000_000_000_000,
      },
    });

    await withEnv({ ANTHROPIC_API_KEY: 'test-api-key' }, async () => {
      const status = await checkCredentials(new ClaudeProviderAuth(async () => null));
      assert.equal(status.authenticated, true);
      assert.equal(status.method, 'api_key');
      assert.equal(status.subscriptionOverride, undefined);
    });
  });
});

test('checkCredentials: a valid subscription login with no API key reports credentials_file and no override', async () => {
  await withTempHome(async (homeDir) => {
    await writeCredentialsFile(homeDir, validSubscriptionCredentials('someone@example.com'));

    await withEnv({}, async () => {
      const status = await checkCredentials(new ClaudeProviderAuth(async () => null));
      assert.equal(status.authenticated, true);
      assert.equal(status.method, 'credentials_file');
      assert.equal(status.email, 'someone@example.com');
      assert.equal(status.subscriptionOverride, undefined);
    });
  });
});

test('getStatus: passes the subscription override through to the wire shape, and omits the key when there is none', async () => {
  await withTempHome(async (homeDir) => {
    await writeCredentialsFile(homeDir, validSubscriptionCredentials('someone@example.com'));

    await withEnv({ ANTHROPIC_API_KEY: 'test-api-key' }, async () => {
      const status = await getStatusWithCliInstalled(new ClaudeProviderAuth(async () => null));
      assert.equal(status.installed, true);
      assert.equal(status.provider, 'claude');
      assert.equal(status.authenticated, true);
      assert.equal(status.method, 'api_key');
      assert.equal(status.email, 'API Key Auth');
      assert.deepEqual(status.subscriptionOverride, {
        variable: 'ANTHROPIC_API_KEY',
        source: 'process_env',
        subscriptionEmail: 'someone@example.com',
      });
    });

    await withEnv({}, async () => {
      const status = await getStatusWithCliInstalled(new ClaudeProviderAuth(async () => null));
      assert.equal(status.method, 'credentials_file');
      // Omitted, not null: existing JSON consumers see exactly the old payload.
      assert.equal('subscriptionOverride' in status, false);
    });
  });
});


test('getStatus: missing credentials file uses the macOS Keychain login', async () => {
  await withTempHome(async () => {
    await withEnv({}, async () => {
      const auth = new ClaudeProviderAuth(async () => JSON.stringify(validSubscriptionCredentials('keychain@example.com')));
      const status = await getStatusWithCliInstalled(auth);
      assert.equal(status.authenticated, true);
      assert.equal(status.method, 'keychain');
      assert.equal(status.email, 'keychain@example.com');
      assert.equal(status.error, undefined);
    });
  });
});

test('checkCredentials: expired or malformed credentials files fall back to a usable Keychain login', async () => {
  await withTempHome(async (homeDir) => {
    await withEnv({}, async () => {
      const auth = new ClaudeProviderAuth(async () => JSON.stringify(validSubscriptionCredentials()));
      await writeCredentialsFile(homeDir, { claudeAiOauth: { accessToken: 'expired', expiresAt: 1 } });
      assert.equal((await checkCredentials(auth)).method, 'keychain');
      await writeFile(path.join(homeDir, '.claude', '.credentials.json'), '{broken');
      assert.equal((await checkCredentials(auth)).method, 'keychain');
    });
  });
});

test('checkCredentials: Keychain refreshable login remains authenticated without refreshing tokens', async () => {
  await withTempHome(async () => {
    await withEnv({}, async () => {
      const auth = new ClaudeProviderAuth(async () => JSON.stringify({
        claudeAiOauth: { accessToken: 'expired', expiresAt: 1, refreshToken: 'refresh' },
      }));
      assert.equal((await checkCredentials(auth)).authenticated, true);
    });
  });
});

test('checkCredentials: unusable Keychain credentials never authenticate or expose secrets', async () => {
  await withTempHome(async () => {
    await withEnv({}, async () => {
      for (const content of ['{secret-invalid-json', '{}', JSON.stringify({ claudeAiOauth: {
        accessToken: 'secret-expired', expiresAt: 1, refreshToken: 'secret-refresh', refreshTokenExpiresAt: 1,
      } })]) {
        const status = await checkCredentials(new ClaudeProviderAuth(async () => content));
        assert.equal(status.authenticated, false);
        assert.doesNotMatch(JSON.stringify(status), /secret/);
      }
      const status = await checkCredentials(new ClaudeProviderAuth(async () => { throw new Error('secret-tool-output'); }));
      assert.equal(status.authenticated, false);
      assert.doesNotMatch(JSON.stringify(status), /secret/);
    });
  });
});

test('checkCredentials: usable file takes priority without reading Keychain', async () => {
  await withTempHome(async (homeDir) => {
    await withEnv({}, async () => {
      await writeCredentialsFile(homeDir, validSubscriptionCredentials('file@example.com'));
      let reads = 0;
      const auth = new ClaudeProviderAuth(async () => { reads += 1; return null; });
      assert.equal((await checkCredentials(auth)).method, 'credentials_file');
      assert.equal(reads, 0);
    });
  });
});

test('checkCredentials: API key still wins and reports bypassed Keychain subscription', async () => {
  await withTempHome(async () => {
    await withEnv({ ANTHROPIC_API_KEY: 'api-key' }, async () => {
      const auth = new ClaudeProviderAuth(async () => JSON.stringify(validSubscriptionCredentials('keychain@example.com')));
      const status = await checkCredentials(auth);
      assert.equal(status.method, 'api_key');
      assert.deepEqual(status.subscriptionOverride, {
        variable: 'ANTHROPIC_API_KEY', source: 'process_env', subscriptionEmail: 'keychain@example.com',
      });
    });
  });
});

test('checkCredentials: custom config directory does not use another account from the default Keychain', async () => {
  await withTempHome(async (homeDir) => {
    const configDir = path.join(homeDir, 'isolated-claude');
    await mkdir(configDir);
    await withEnv({ CLAUDE_CONFIG_DIR: configDir }, async () => {
      let reads = 0;
      const auth = new ClaudeProviderAuth(async () => { reads += 1; return JSON.stringify(validSubscriptionCredentials()); });
      assert.equal((await checkCredentials(auth)).authenticated, false);
      assert.equal(reads, 0);
      await writeFile(path.join(configDir, '.credentials.json'), JSON.stringify(validSubscriptionCredentials('custom@example.com')));
      assert.equal((await checkCredentials(auth)).email, 'custom@example.com');
    });
  });
});


test('checkCredentials: custom settings ignore default API keys and read only the selected configuration', async () => {
  await withTempHome(async (homeDir) => {
    await writeSettingsFile(homeDir, { ANTHROPIC_API_KEY: 'default-account-key' });
    const configDir = path.join(homeDir, 'custom-config');
    await mkdir(configDir);
    await withEnv({ CLAUDE_CONFIG_DIR: configDir }, async () => {
      const auth = new ClaudeProviderAuth(async () => null);
      assert.equal((await checkCredentials(auth)).authenticated, false);
      await writeFile(path.join(configDir, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_API_KEY: 'custom-account-key' } }));
      assert.equal((await checkCredentials(auth)).method, 'api_key');
    });
  });
});
