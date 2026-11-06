import { spawn, type ChildProcess } from 'node:child_process';

import { AppError, resolveKimiCliPath, stripAnsiSequences } from '@/shared/utils.js';
import { invalidateKimiAuthStatusCache } from '@/modules/providers/list/kimi/kimi-auth.provider.js';

/** A device-code login takes a minute or two; this only stops orphaned processes. */
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const OUTPUT_TAIL_LIMIT = 4_000;
const MAX_MESSAGE_LENGTH = 1_500;

export type KimiLoginState =
  | 'idle'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed_out';

export type KimiLoginStatus = {
  state: KimiLoginState;
  /** Device verification URL Kimi printed, when captured. */
  verificationUrl: string | null;
  /** Device user code Kimi printed, when captured. */
  userCode: string | null;
  /** Bounded diagnostic tail; never contains tokens or environment values. */
  message: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
};

const idleStatus = (): KimiLoginStatus => ({
  state: 'idle',
  verificationUrl: null,
  userCode: null,
  message: null,
  startedAt: null,
  finishedAt: null,
  exitCode: null,
});

let status: KimiLoginStatus = idleStatus();
let activeProcess: ChildProcess | null = null;
let activeTimer: NodeJS.Timeout | null = null;

/**
 * Runs `kimi login` and exposes the device-code flow to the UI.
 *
 * Kimi owns the OAuth exchange: CloudCLI only captures the verification URL and
 * user code from the process output, then polls its own auth status until the
 * CLI exits. Only one login process exists at a time, so repeated clicks cannot
 * leave orphaned device-code flows behind.
 */
export const kimiLoginService = {
  start(options: { region?: string } = {}): KimiLoginStatus {
    if (activeProcess) {
      throw new AppError('A Kimi login is already in progress.', {
        code: 'KIMI_LOGIN_IN_PROGRESS',
        statusCode: 409,
      });
    }

    const region = options.region?.trim();
    const args = ['login', ...(region ? ['--region', region] : [])];
    const cliPath = resolveKimiCliPath();
    const child = spawn(cliPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    status = {
      ...idleStatus(),
      state: 'running',
      startedAt: new Date().toISOString(),
    };
    activeProcess = child;

    let output = '';
    const capture = (chunk: Buffer) => {
      output = (output + stripAnsiSequences(chunk.toString('utf8'))).slice(-OUTPUT_TAIL_LIMIT);
      status = {
        ...status,
        ...extractKimiDeviceCode(output),
        message: buildMessage(output),
      };
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    child.stdout?.on('error', () => undefined);
    child.stderr?.on('error', () => undefined);

    child.on('error', (error) => {
      finish('failed', null, `Could not start the Kimi login process: ${error.message}`);
    });
    child.on('exit', (code) => {
      if (status.state !== 'running') {
        return;
      }
      if (code === 0) {
        finish('succeeded', code, 'Kimi Code CLI is now logged in.');
        invalidateKimiAuthStatusCache();
      } else {
        finish('failed', code, buildMessage(output) ?? `Kimi login exited with code ${code}.`);
      }
    });

    activeTimer = setTimeout(() => {
      if (activeProcess === child) {
        child.kill('SIGTERM');
        finish('timed_out', null, 'Kimi login timed out before authorization completed.');
      }
    }, LOGIN_TIMEOUT_MS);

    return this.getStatus();
  },

  getStatus(): KimiLoginStatus {
    return { ...status };
  },

  /** Stops an in-flight login; a login that already finished is left as it is. */
  cancel(): KimiLoginStatus {
    if (!activeProcess) {
      return this.getStatus();
    }

    const child = activeProcess;
    activeProcess = null;
    clearTimer();
    child.kill('SIGTERM');
    status = {
      ...status,
      state: 'cancelled',
      finishedAt: new Date().toISOString(),
      message: 'Kimi login was cancelled.',
    };
    return this.getStatus();
  },

  /** Called on backend shutdown so no login process outlives the server. */
  close(): void {
    if (activeProcess) {
      activeProcess.kill('SIGKILL');
      activeProcess = null;
    }
    clearTimer();
  },
};

function finish(state: KimiLoginState, exitCode: number | null, message: string | null): void {
  activeProcess = null;
  clearTimer();
  status = {
    ...status,
    state,
    exitCode,
    message,
    finishedAt: new Date().toISOString(),
  };
}

function clearTimer(): void {
  if (activeTimer) {
    clearTimeout(activeTimer);
    activeTimer = null;
  }
}

/**
 * Extracts the verification URL and user code from Kimi's login output.
 *
 * Kimi's device flow prints "paste the URL ... and enter code: XXXX-XXXX"; the
 * patterns also accept the generic "enter code <code>" wording so a future
 * message change does not blind the modal.
 *
 * Exported for the login service's tests.
 */
export function extractKimiDeviceCode(
  output: string,
): Pick<KimiLoginStatus, 'verificationUrl' | 'userCode'> {
  const urlMatch = output.match(/https?:\/\/[^\s"'<>]+/);
  const codeMatch = output.match(/(?:enter\s+(?:the\s+)?code|user\s*code)[:\s]+([A-Z0-9]{4}(?:-[A-Z0-9]{4})*)/i)
    ?? output.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4,})\b/);

  return {
    verificationUrl: urlMatch ? urlMatch[0] : null,
    userCode: codeMatch ? codeMatch[1] : null,
  };
}

/** Keeps the last non-empty lines so the modal can show a real error. */
function buildMessage(output: string): string | null {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return null;
  }

  return lines.slice(-8).join('\n').slice(-MAX_MESSAGE_LENGTH);
}