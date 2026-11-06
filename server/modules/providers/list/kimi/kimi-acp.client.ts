import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';

import * as acp from '@agentclientprotocol/sdk';

import { AppError, resolveKimiCliPath } from '@/shared/utils.js';

/** How long one ACP request may stay unanswered before the turn is failed. */
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
/** A model turn can legitimately take minutes; only the prompt gets this budget. */
const DEFAULT_PROMPT_TIMEOUT_MS = 30 * 60_000;
/** Grace period after `session/close` before the child is killed outright. */
const PROCESS_EXIT_GRACE_MS = 2_000;
/** Tail kept for diagnostics; never includes environment variables. */
const STDERR_TAIL_LIMIT = 8_192;

/** JSON-RPC code ACP uses for "authentication required". */
const AUTH_REQUIRED_CODE = -32000;

export type KimiAcpPermissionRequest = {
  /** App-generated id the permission gateway answers by. */
  requestId: string;
  sessionId: string;
  toolCall: acp.ToolCallUpdate;
  options: acp.PermissionOption[];
};

export type KimiAcpClientCallbacks = {
  /** Every `session/update` notification, live or during a history replay. */
  onSessionUpdate: (update: acp.SessionUpdate) => void;
  /** Resolves with the outcome returned to Kimi; a rejection cancels the request. */
  onPermissionRequest: (request: KimiAcpPermissionRequest) => Promise<acp.RequestPermissionResponse>;
};

export type KimiAcpClientOptions = KimiAcpClientCallbacks & {
  /** CLI executable; defaults to `KIMI_CLI_PATH` or `kimi` on PATH. */
  cliPath?: string;
  requestTimeoutMs?: number;
  promptTimeoutMs?: number;
};

/**
 * One `kimi acp` child process and its ACP connection.
 *
 * A client owns exactly one turn (or one history read): CloudCLI starts it,
 * runs the ACP sequence, and closes it, which is what keeps a crashed turn from
 * leaking a long-lived agent process. It never retries on its own and never
 * writes protocol output anywhere but the child's stdin.
 */
export class KimiAcpClient {
  private readonly child: ChildProcess;
  private readonly connection: acp.ClientConnection;
  private readonly stderrChunks: string[] = [];
  private stderrTail = '';
  private exitError: Error | null = null;
  private closed = false;
  private readonly requestTimeoutMs: number;
  private readonly promptTimeoutMs: number;

  private constructor(
    child: ChildProcess,
    connection: acp.ClientConnection,
    options: KimiAcpClientOptions,
  ) {
    this.child = child;
    this.connection = connection;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.promptTimeoutMs = options.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS;
  }

  /**
   * Spawns `kimi acp` and connects to it.
   *
   * `ENOENT` becomes a `KIMI_CLI_NOT_FOUND` AppError — "not installed or not on
   * PATH" — so callers never report an installation problem as a login problem.
   */
  static async start(options: KimiAcpClientOptions): Promise<KimiAcpClient> {
    const cliPath = options.cliPath ?? resolveKimiCliPath();
    const child = spawn(cliPath, ['acp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    await waitForSpawn(child, cliPath);

    const app = acp
      .client({ name: 'CloudCLI' })
      .onNotification(acp.methods.client.session.update, (context) => {
        options.onSessionUpdate(context.params.update);
      })
      .onRequest(acp.methods.client.session.requestPermission, async (context) => {
        const params = context.params;
        return options.onPermissionRequest({
          requestId: `kimi-perm-${randomUUID()}`,
          sessionId: params.sessionId,
          toolCall: params.toolCall,
          options: params.options,
        });
      });

    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
    );
    const connection = app.connect(stream);
    const client = new KimiAcpClient(child, connection, options);
    client.wireProcess();
    return client;
  }

  /** Negotiates protocol version and capabilities with the agent. */
  async initialize(): Promise<acp.InitializeResponse> {
    return this.request(acp.methods.agent.initialize, {
      protocolVersion: 1,
      // fs and terminal deliberately stay unadvertised: Kimi runs its own
      // tools in the workspace, and CloudCLI does not implement either surface.
      clientCapabilities: {},
      clientInfo: { name: 'CloudCLI', version: '1.0.0' },
    });
  }

  /** Creates a session and returns Kimi's advertised modes/config options. */
  async newSession(cwd: string): Promise<acp.NewSessionResponse> {
    return this.request(acp.methods.agent.session.new, { cwd, mcpServers: [] });
  }

  /** Resumes a session without replaying its history. */
  async resumeSession(sessionId: string, cwd: string): Promise<acp.ResumeSessionResponse> {
    return this.request(acp.methods.agent.session.resume, {
      sessionId,
      cwd,
      mcpServers: [],
    });
  }

  /** Loads a session, streaming its full history back as `session/update`. */
  async loadSession(sessionId: string, cwd: string): Promise<acp.LoadSessionResponse> {
    return this.request(acp.methods.agent.session.load, {
      sessionId,
      cwd,
      mcpServers: [],
    });
  }

  /** Switches the session's operational mode (permission behaviour). */
  async setSessionMode(sessionId: string, modeId: string): Promise<void> {
    await this.request(acp.methods.agent.session.setMode, { sessionId, modeId });
  }

  /** Sets one advertised config option (model, thinking level, ...). */
  async setSessionConfigOption(
    sessionId: string,
    configId: string,
    value: string | boolean,
  ): Promise<acp.SetSessionConfigOptionResponse> {
    const params: acp.SetSessionConfigOptionRequest = typeof value === 'boolean'
      ? { sessionId, configId, type: 'boolean', value }
      : { sessionId, configId, value };
    return this.request(acp.methods.agent.session.setConfigOption, params);
  }

  /** Sends one user turn and resolves with its stop reason. */
  async prompt(sessionId: string, prompt: acp.ContentBlock[]): Promise<acp.PromptResponse> {
    return this.request(
      acp.methods.agent.session.prompt,
      { sessionId, prompt },
      this.promptTimeoutMs,
    );
  }

  /** Asks the agent to cancel the current turn; it may still send trailing updates. */
  async cancel(sessionId: string): Promise<void> {
    await this.connection.agent.notify(acp.methods.agent.session.cancel, { sessionId });
  }

  /** Ends the session and releases the process. Never throws. */
  async close(sessionId?: string): Promise<void> {
    if (this.closed) {
      return;
    }

    if (sessionId) {
      try {
        await this.request(acp.methods.agent.session.close, { sessionId }, 3_000);
      } catch {
        // Closing is best-effort: the process is killed below either way.
      }
    }

    this.closed = true;
    this.connection.close();
    this.child.stdin?.end();
    await this.waitForExit();
  }

  /** Drops the connection and kills the child immediately. */
  kill(): void {
    this.closed = true;
    try {
      this.connection.close(new Error('Kimi ACP client was stopped.'));
    } catch {
      // The connection may already be gone.
    }
    this.child.stdin?.destroy();
    this.child.stdout?.destroy();
    this.child.stderr?.destroy();
    this.child.kill('SIGKILL');
  }

  /** Bounded stderr tail, for error messages only. */
  getStderrTail(): string {
    return this.stderrTail;
  }

  /** Whether the child has exited, with the error it exited on when known. */
  getExitError(): Error | null {
    return this.exitError;
  }

  private async request<TResult>(
    method: string,
    params: unknown,
    timeoutMs = this.requestTimeoutMs,
    options: acp.SendRequestOptions = {},
  ): Promise<TResult> {
    if (this.closed) {
      throw new AppError('Kimi ACP process is no longer running.', {
        code: 'KIMI_ACP_CLOSED',
        statusCode: 502,
      });
    }

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new AppError(`Kimi ACP request "${method}" timed out.`, {
          code: 'KIMI_ACP_TIMEOUT',
          statusCode: 504,
          details: { method },
        }));
      }, timeoutMs);
    });

    try {
      const request = this.connection.agent.request(method, params as never, options) as Promise<TResult>;
      return await Promise.race([request, timeout]);
    } catch (error) {
      throw toKimiAcpError(error, this.stderrTail || this.exitError?.message || '');
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private wireProcess(): void {
    const child = this.child;
    child.stderr?.on('data', (chunk: Buffer) => {
      this.appendStderr(chunk.toString('utf8'));
    });
    child.stderr?.on('error', (error) => {
      this.recordExitError(error);
    });
    child.stdin?.on('error', (error) => {
      // EPIPE after the agent exits is expected; keep it for diagnostics.
      this.recordExitError(error);
    });
    child.stdout?.on('error', (error) => {
      this.recordExitError(error);
    });
    child.on('error', (error) => {
      this.recordExitError(error);
      this.closed = true;
    });
    child.on('exit', (code, signal) => {
      this.closed = true;
      if (!this.exitError && (code ?? 0) !== 0) {
        this.exitError = new AppError(
          `Kimi ACP exited with ${signal ? `signal ${signal}` : `code ${code}`}.`,
          { code: 'KIMI_ACP_EXITED', statusCode: 502 },
        );
      }
    });
    // Reject every pending request as soon as the transport goes away.
    void this.connection.closed.then(() => {
      this.closed = true;
    });
  }

  private appendStderr(text: string): void {
    if (!text) {
      return;
    }

    this.stderrChunks.push(text);
    this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL_LIMIT);
    // Drop the oldest chunks once their concatenation is far past the tail.
    while (this.stderrChunks.join('').length > STDERR_TAIL_LIMIT * 2) {
      this.stderrChunks.shift();
    }
  }

  private recordExitError(error: Error): void {
    if (!this.exitError) {
      this.exitError = error;
    }
  }

  private async waitForExit(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return;
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill('SIGKILL');
        resolve();
      }, PROCESS_EXIT_GRACE_MS);
      this.child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

/** Resolves once the OS reports the spawn, rejects with a friendly ENOENT error. */
function waitForSpawn(child: ChildProcess, cliPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSpawn = () => {
      cleanup();
      resolve();
    };
    const onError = (error: NodeJS.ErrnoException) => {
      cleanup();
      if (error.code === 'ENOENT') {
        reject(new AppError(
          `Kimi Code CLI was not found at "${cliPath}". Install it or set KIMI_CLI_PATH to its executable.`,
          { code: 'KIMI_CLI_NOT_FOUND', statusCode: 503, details: { cliPath } },
        ));
        return;
      }
      reject(new AppError(`Could not start Kimi Code CLI: ${error.message}`, {
        code: 'KIMI_CLI_START_FAILED',
        statusCode: 502,
      }));
    };
    const cleanup = () => {
      child.off('spawn', onSpawn);
      child.off('error', onError);
    };

    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

/**
 * Converts an ACP/transport failure into a diagnosable AppError.
 *
 * Authentication failures keep their own code so the providers UI can say
 * "installed but not logged in" instead of "installation broken".
 */
export function toKimiAcpError(error: unknown, stderrTail = ''): AppError {
  if (error instanceof AppError) {
    return error;
  }

  if (error instanceof acp.RequestError) {
    if (error.code === AUTH_REQUIRED_CODE) {
      return new AppError('Kimi Code CLI is not authenticated. Run the Kimi login flow first.', {
        code: 'KIMI_NOT_AUTHENTICATED',
        statusCode: 401,
        details: { acpCode: error.code, acpData: error.data },
      });
    }

    return new AppError(`Kimi ACP error ${error.code}: ${error.message}`, {
      code: 'KIMI_ACP_ERROR',
      statusCode: 502,
      details: { acpCode: error.code, acpData: error.data, stderrTail },
    });
  }

  const message = error instanceof Error ? error.message : String(error);
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') {
    return new AppError(
      'Kimi Code CLI is not installed or not on PATH (set KIMI_CLI_PATH to its executable).',
      { code: 'KIMI_CLI_NOT_FOUND', statusCode: 503, details: { stderrTail } },
    );
  }

  return new AppError(`Kimi ACP request failed: ${message}`, {
    code: 'KIMI_ACP_ERROR',
    statusCode: 502,
    details: { stderrTail },
  });
}