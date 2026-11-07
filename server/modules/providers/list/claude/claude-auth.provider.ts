import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';
import type { IProviderAuth } from '@/shared/interfaces.js';
import type { CliVersionProbe, ProviderAuthStatus, ProviderAuthSubscriptionOverride } from '@/shared/types.js';
import { probeCliVersion, readObjectRecord, readOptionalString } from '@/shared/utils.js';

type ClaudeCredentialsStatus = {
  authenticated: boolean;
  email: string | null;
  method: string | null;
  error?: string;
  subscriptionOverride?: ProviderAuthSubscriptionOverride;
};

/**
 * An API-key style credential found in the env or settings.json, plus the
 * user-facing label the settings UI has always shown for it. The labels are
 * kept verbatim so existing consumers of `email` see no change.
 */
type ClaudeApiKeyCredential = Pick<ProviderAuthSubscriptionOverride, 'variable' | 'source'> & {
  label: string;
};

const execFileAsync = promisify(execFile);
const MISSING_CREDENTIALS_ERROR = 'Claude CLI is not authenticated. Run claude /login or configure ANTHROPIC_API_KEY.';

/** Reads Claude Code's default macOS credential store without invoking a shell or renewing tokens. */
const readClaudeKeychain = async (): Promise<string | null> => {
  if (process.platform !== 'darwin') return null;
  try {
    const { stdout } = await execFileAsync('/usr/bin/security', [
      'find-generic-password', '-s', 'Claude Code-credentials', '-w',
    ], { encoding: 'utf8', timeout: 3000, maxBuffer: 1024 * 1024 });
    return stdout.trim() || null;
  } catch {
    // Missing/locked Keychain entries and command failures must never expose credential output.
    return null;
  }
};

/** Checks a filesystem error code without exposing its potentially sensitive message. */
const hasErrorCode = (error: unknown, code: string): boolean => (
  error instanceof Error && 'code' in error && error.code === code
);

/** Provides Claude installation and login status to the providers module's registry. */
export class ClaudeProviderAuth implements IProviderAuth {
  /** Allows credential-store adapters to be supplied without accessing the real Keychain in tests. */
  constructor(private readonly readKeychain: () => Promise<string | null> = readClaudeKeychain) {}

  /** Resolves the same configuration directory for settings and file-based login credentials. */
  private getConfigDirectory(): string {
    return path.resolve(process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), '.claude'));
  }
  /**
   * Checks whether the Claude Code CLI that chats run is available on this
   * host, and which version it is.
   */
  checkInstalled(): CliVersionProbe {
    const cliPath = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);
    if (!cliPath) {
      // Windows with no resolvable CLI: the SDK falls back to the binary it
      // bundles, so chats still work. Its version is not this CLI's to report.
      return { installed: true, exitCode: null, version: null };
    }
    return probeCliVersion(cliPath);
  }

  /**
   * Returns Claude installation and credential status using Claude Code's auth priority.
   */
  async getStatus(): Promise<ProviderAuthStatus> {
    const { installed, version: installedVersion } = this.checkInstalled();

    if (!installed) {
      return {
        installed,
        provider: 'claude',
        installedVersion,
        authenticated: false,
        email: null,
        method: null,
        error: 'Claude Code CLI is not installed',
      };
    }

    const credentials = await this.checkCredentials();

    return {
      installed,
      provider: 'claude',
      installedVersion,
      authenticated: credentials.authenticated,
      email: credentials.authenticated ? credentials.email || 'Authenticated' : credentials.email,
      method: credentials.method,
      error: credentials.authenticated ? undefined : credentials.error || 'Not authenticated',
      ...(credentials.subscriptionOverride ? { subscriptionOverride: credentials.subscriptionOverride } : {}),
    };
  }

  /**
   * Reads Claude settings env values that the CLI can use even when the server process env is empty.
   */
  private async loadSettingsEnv(): Promise<Record<string, unknown>> {
    try {
      const settingsPath = path.join(this.getConfigDirectory(), 'settings.json');
      const content = await readFile(settingsPath, 'utf8');
      const settings = readObjectRecord(JSON.parse(content));
      return readObjectRecord(settings?.env) ?? {};
    } catch {
      return {};
    }
  }

  /**
   * Finds an API-key style credential in the same order Claude Code checks them:
   * process env first (auth token, then API key), then the settings.json env block.
   */
  private findApiKeyCredential(settingsEnv: Record<string, unknown>): ClaudeApiKeyCredential | null {
    if (process.env.ANTHROPIC_AUTH_TOKEN?.trim()) {
      return { variable: 'ANTHROPIC_AUTH_TOKEN', source: 'process_env', label: 'Auth Token' };
    }

    if (process.env.ANTHROPIC_API_KEY?.trim()) {
      return { variable: 'ANTHROPIC_API_KEY', source: 'process_env', label: 'API Key Auth' };
    }

    if (readOptionalString(settingsEnv.ANTHROPIC_API_KEY)) {
      return { variable: 'ANTHROPIC_API_KEY', source: 'settings_file', label: 'API Key Auth' };
    }

    if (readOptionalString(settingsEnv.ANTHROPIC_AUTH_TOKEN)) {
      return { variable: 'ANTHROPIC_AUTH_TOKEN', source: 'settings_file', label: 'Configured via settings.json' };
    }

    return null;
  }

  /**
   * Checks Claude credentials in the same priority order used by Claude Code.
   */
  private async checkCredentials(): Promise<ClaudeCredentialsStatus> {
    const settingsEnv = await this.loadSettingsEnv();

    const apiKey = this.findApiKeyCredential(settingsEnv);
    if (apiKey) {
      const status: ClaudeCredentialsStatus = { authenticated: true, email: apiKey.label, method: 'api_key' };

      // The key wins, but Claude Code says nothing when it does so while a
      // `claude /login` subscription is also signed in — every request is then
      // billed pay-as-you-go to the key (issue #568). Surface the bypassed
      // login so the settings page can warn about it; an expired or missing
      // login is not being bypassed, so it stays silent.
      const subscription = await this.readSubscriptionCredentials();
      if (subscription.authenticated) {
        status.subscriptionOverride = {
          variable: apiKey.variable,
          source: apiKey.source,
          subscriptionEmail: subscription.email,
        };
      }

      return status;
    }

    if (process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) {
      return { authenticated: true, email: 'OAuth Token (long-lived)', method: 'environment' };
    }

    if (readOptionalString(settingsEnv.CLAUDE_CODE_OAUTH_TOKEN)) {
      return { authenticated: true, email: 'OAuth Token (long-lived)', method: 'environment' };
    }

    return this.readSubscriptionCredentials();
  }

  /**
   * Reads file credentials first, then the default macOS Keychain. A custom config
   * directory never falls back to another account's default Keychain entry.
   */
  private async readSubscriptionCredentials(): Promise<ClaudeCredentialsStatus> {
    const fileStatus = await this.readCredentialsFile();
    if (fileStatus.authenticated || this.getConfigDirectory() !== path.join(os.homedir(), '.claude')) {
      return fileStatus;
    }
    try {
      const content = await this.readKeychain();
      if (content) return this.parseCredentials(content, 'keychain');
    } catch {
      // An unavailable credential store leaves the existing file status intact.
    }
    return fileStatus;
  }

  /** Reads file-based login state while retaining actionable, sanitized failure messages. */
  private async readCredentialsFile(): Promise<ClaudeCredentialsStatus> {
    try {
      const credPath = path.join(this.getConfigDirectory(), '.credentials.json');
      const content = await readFile(credPath, 'utf8');
      return this.parseCredentials(content, 'credentials_file');
    } catch (error) {
      return {
        authenticated: false,
        email: null,
        method: null,
        error: hasErrorCode(error, 'ENOENT')
          ? MISSING_CREDENTIALS_ERROR
          : 'Unable to read Claude credentials. Run claude /login again.',
      };
    }
  }

  /** Applies the same OAuth expiry and refreshability rules to both supported credential stores. */
  private parseCredentials(content: string, method: 'credentials_file' | 'keychain'): ClaudeCredentialsStatus {
    try {
      const creds = readObjectRecord(JSON.parse(content)) ?? {};
      const oauth = readObjectRecord(creds.claudeAiOauth);
      const accessToken = readOptionalString(oauth?.accessToken);

      if (accessToken) {
        const expiresAt = typeof oauth?.expiresAt === 'number' ? oauth.expiresAt : undefined;
        const email = readOptionalString(creds.email) ?? readOptionalString(creds.user) ?? null;
        if (!expiresAt || Date.now() < expiresAt) {
          return {
            authenticated: true,
            email,
            method,
          };
        }

        // `accessToken` is short-lived (hours). Claude Code renews it silently
        // from `refreshToken` on the next CLI invocation, so an expired access
        // token alongside a live refresh token is still a working login. Before
        // this check, a still-signed-in account read as "login has expired"
        // until something else happened to run the CLI — which is why opening
        // the Shell tab and coming back made Settings flip to Connected.
        const refreshToken = readOptionalString(oauth?.refreshToken);
        const refreshTokenExpiresAt = typeof oauth?.refreshTokenExpiresAt === 'number'
          ? oauth.refreshTokenExpiresAt
          : undefined;
        if (refreshToken && (!refreshTokenExpiresAt || Date.now() < refreshTokenExpiresAt)) {
          return {
            authenticated: true,
            email,
            method,
          };
        }

        return {
          authenticated: false,
          email: null,
          method: null,
          error: 'Claude login has expired. Run claude /login again.',
        };
      }

      return {
        authenticated: false,
        email: null,
        method: null,
        error: MISSING_CREDENTIALS_ERROR,
      };
    } catch (error) {
      let errorMessage = 'Unable to read Claude credentials. Run claude /login again.';

      if (error instanceof SyntaxError) {
        errorMessage = 'Claude credentials are unreadable. Run claude /login again.';
      }

      return {
        authenticated: false,
        email: null,
        method: null,
        error: errorMessage,
      };
    }
  }
}
