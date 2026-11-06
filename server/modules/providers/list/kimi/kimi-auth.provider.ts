import os from 'node:os';

import type { IProviderAuth } from '@/shared/interfaces.js';
import type { CliVersionProbe, ProviderAuthStatus } from '@/shared/types.js';
import { probeCliVersion, resolveKimiCliPath } from '@/shared/utils.js';
import { KimiAcpClient, toKimiAcpError } from '@/modules/providers/list/kimi/kimi-acp.client.js';

const PROVIDER = 'kimi' as const;
/** A status check spawns the CLI; settings polls reuse the last answer briefly. */
const AUTH_STATUS_TTL_MS = 5 * 60_000;
const AUTH_CHECK_TIMEOUT_MS = 20_000;

let cachedStatus: { value: ProviderAuthStatus; expiresAt: number } | null = null;

/** Drops the cached auth answer, e.g. right after a login or logout. */
export function invalidateKimiAuthStatusCache(): void {
  cachedStatus = null;
}

/**
 * Installation and authentication status for Kimi Code CLI.
 *
 * Authentication is probed with a short-lived ACP handshake (`session/new`
 * against a throwaway directory), never by reading or copying Kimi's token
 * files. A CLI that is present but logged out reports `authenticated: false`
 * with its own error; a missing CLI reports `installed: false` and is never
 * conflated with "not logged in".
 */
export class KimiProviderAuth implements IProviderAuth {
  checkInstalled(): CliVersionProbe {
    return probeCliVersion(resolveKimiCliPath());
  }

  async getStatus(): Promise<ProviderAuthStatus> {
    const cached = cachedStatus;
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const value = await this.readStatus();
    cachedStatus = { value, expiresAt: Date.now() + AUTH_STATUS_TTL_MS };
    return value;
  }

  private async readStatus(): Promise<ProviderAuthStatus> {
    const { installed, version: installedVersion } = this.checkInstalled();
    if (!installed) {
      return {
        installed: false,
        provider: PROVIDER,
        installedVersion: null,
        authenticated: false,
        email: null,
        method: null,
        error: 'Kimi Code CLI is not installed or not on PATH.',
      };
    }

    const probe = await this.probeAuthentication();
    return {
      installed: true,
      provider: PROVIDER,
      installedVersion,
      authenticated: probe.authenticated,
      email: null,
      method: probe.authenticated ? 'kimi-code-cli' : null,
      ...(probe.error ? { error: probe.error } : {}),
    };
  }

  /** Creates and immediately closes one session; only its outcome matters. */
  private async probeAuthentication(): Promise<{ authenticated: boolean; error?: string }> {
    let client: KimiAcpClient | null = null;
    let sessionId: string | undefined;
    try {
      client = await KimiAcpClient.start({
        onSessionUpdate: () => undefined,
        onPermissionRequest: async () => ({ outcome: { outcome: 'cancelled' } }),
        requestTimeoutMs: AUTH_CHECK_TIMEOUT_MS,
      });
      await client.initialize();
      const session = await client.newSession(os.tmpdir());
      sessionId = session.sessionId;
      return { authenticated: true };
    } catch (error) {
      const normalized = toKimiAcpError(error, client?.getStderrTail() ?? '');
      return {
        authenticated: false,
        error: normalized.code === 'KIMI_NOT_AUTHENTICATED'
          ? 'Not authenticated. Use the Kimi login flow.'
          : normalized.message,
      };
    } finally {
      await client?.close(sessionId).catch(() => undefined);
    }
  }
}