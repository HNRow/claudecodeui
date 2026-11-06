import { readFile } from 'node:fs/promises';
import path from 'node:path';

import mime from 'mime-types';
import type * as acp from '@agentclientprotocol/sdk';

import type { IProviderRuntime } from '@/shared/interfaces.js';
import type {
  AnyRecord,
  ProviderPermissionDecision,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
} from '@/shared/types.js';
import {
  AppError,
  createCompleteMessage,
  createNormalizedMessage,
  readObjectRecord,
} from '@/shared/utils.js';
import {
  KimiAcpClient,
  toKimiAcpError,
  type KimiAcpPermissionRequest,
} from '@/modules/providers/list/kimi/kimi-acp.client.js';
import { kimiLoginService } from '@/modules/providers/list/kimi/kimi-login.service.js';
import type { KimiUpdateEnvelope } from '@/modules/providers/list/kimi/kimi-sessions.provider.js';

const PROVIDER = 'kimi' as const;
/** A permission prompt is answered by a human; this only stops leaked waits. */
const PERMISSION_TIMEOUT_MS = Number(process.env.KIMI_PERMISSION_TIMEOUT_MS ?? 10 * 60_000);
/** How long `abort()` waits for Kimi to finish the cancelled turn before killing it. */
const ABORT_SETTLE_TIMEOUT_MS = 5_000;

type PendingPermission = {
  requestId: string;
  turnKey: string;
  sessionId: string;
  toolName: string;
  input: unknown;
  context: unknown;
  receivedAt: number;
  finish: (response: acp.RequestPermissionResponse, cancelledReason?: string) => void;
};

type KimiTurn = {
  key: string;
  sessionId: string;
  writer: ProviderRuntimeWriter;
  client: KimiAcpClient | null;
  providerSessionId: string | null;
  aborted: boolean;
  promptSettled: Promise<void> | null;
  resolvePromptSettled: (() => void) | null;
  streamOpen: boolean;
  thoughtBuffer: string;
  sequence: number;
};

const activeTurns = new Map<string, KimiTurn>();
const pendingPermissions = new Map<string, PendingPermission>();
/** Session-scoped "always allow" cache; rebuilt per turn, dropped with the backend. */
const rememberedToolApprovals = new Map<string, Set<string>>();

/**
 * Runs one Kimi chat turn over ACP.
 *
 * Every turn gets its own `kimi acp` process (session/new or session/resume),
 * which keeps crashed turns from leaking a long-lived agent and makes session
 * isolation trivial. The process is closed in `finally`, whatever happened.
 */
async function runKimiTurn(
  command: string,
  options: AnyRecord,
  writer: ProviderRuntimeWriter,
  context: ProviderRuntimeContext,
): Promise<void> {
  const appSessionId = typeof options.sessionId === 'string' && options.sessionId
    ? options.sessionId
    : null;
  const resumeSessionId = context.resolveProviderSessionId(appSessionId);
  const cwd = typeof options.cwd === 'string' && options.cwd
    ? options.cwd
    : typeof options.projectPath === 'string' && options.projectPath
      ? options.projectPath
      : process.cwd();
  const key = appSessionId ?? resumeSessionId ?? `kimi-${Date.now()}`;
  const turnSessionId = appSessionId ?? resumeSessionId ?? key;

  if (activeTurns.has(key)) {
    throw new AppError('A Kimi turn is already running for this session.', {
      code: 'KIMI_RUN_IN_PROGRESS',
      statusCode: 409,
    });
  }

  const turn: KimiTurn = {
    key,
    sessionId: turnSessionId,
    writer,
    client: null,
    providerSessionId: resumeSessionId,
    aborted: false,
    promptSettled: null,
    resolvePromptSettled: null,
    streamOpen: false,
    thoughtBuffer: '',
    sequence: 0,
  };
  activeTurns.set(key, turn);
  installExitHook();

  const send = (message: unknown) => writer.send(message);
  let protocolErrorSent = false;

  const sendError = (content: string) => {
    // A failed turn reports its cause once; the process-exit error that follows
    // is transport noise, not a second problem.
    protocolErrorSent = true;
    send(createNormalizedMessage({
      kind: 'error',
      content,
      sessionId: turn.sessionId,
      provider: PROVIDER,
    }));
  };

  const closeStream = () => {
    if (!turn.streamOpen) {
      return;
    }
    turn.streamOpen = false;
    send(createNormalizedMessage({
      kind: 'stream_end',
      sessionId: turn.sessionId,
      provider: PROVIDER,
    }));
  };

  const flushThought = () => {
    const text = turn.thoughtBuffer;
    turn.thoughtBuffer = '';
    if (!text) {
      return;
    }
    send(createNormalizedMessage({
      id: `kimi_thought_${turn.key}_${turn.sequence++}`,
      kind: 'thinking',
      content: text,
      role: 'assistant',
      sessionId: turn.sessionId,
      provider: PROVIDER,
    }));
  };

  const forwardUpdate = (update: acp.SessionUpdate) => {
    if (turn.aborted) {
      return;
    }

    if (update.sessionUpdate === 'agent_thought_chunk') {
      const chunk = readObjectRecord(update.content);
      if (chunk?.type === 'text' && typeof chunk.text === 'string') {
        closeStream();
        turn.thoughtBuffer += chunk.text;
      }
      return;
    }

    if (update.sessionUpdate === 'agent_message_chunk') {
      flushThought();
      turn.streamOpen = true;
      for (const message of context.normalizeMessage(
        { update, historical: false, sequence: turn.sequence++ } satisfies KimiUpdateEnvelope,
        turn.sessionId,
      )) {
        send(message);
      }
      return;
    }

    flushThought();
    closeStream();
    // The ACP session id Kimi reports is the provider-native one; the chat
    // writer remaps every outbound row onto the app session id anyway.
    for (const message of context.normalizeMessage(
      { update, historical: false, sequence: turn.sequence++ } satisfies KimiUpdateEnvelope,
      turn.sessionId,
    )) {
      send(message);
    }
  };

  const handlePermission = async (
    request: KimiAcpPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> => {
    if (turn.aborted) {
      return { outcome: { outcome: 'cancelled' } };
    }

    const toolName = readObjectRecord(request.toolCall)?.name;
    const resolvedToolName = typeof toolName === 'string' && toolName
      ? toolName
      : typeof request.toolCall.title === 'string' && request.toolCall.title
        ? request.toolCall.title
        : 'Tool';
    const toolInput = request.toolCall.rawInput ?? { title: request.toolCall.title };

    const automatic = resolveAutomaticPermission(
      options,
      turnSessionId,
      resolvedToolName,
      toolInput,
    );
    if (automatic) {
      return selectPermissionOutcome(request.options, automatic);
    }

    return new Promise<acp.RequestPermissionResponse>((resolve) => {
      const requestId = request.requestId;
      let timer: NodeJS.Timeout | undefined;

      const finish = (
        response: acp.RequestPermissionResponse,
        cancelledReason?: string,
      ) => {
        if (pendingPermissions.get(requestId)?.requestId !== requestId) {
          return;
        }
        pendingPermissions.delete(requestId);
        if (timer) {
          clearTimeout(timer);
        }
        send(createNormalizedMessage(
          cancelledReason
            ? {
              kind: 'permission_cancelled',
              requestId,
              reason: cancelledReason,
              sessionId: turn.sessionId,
              provider: PROVIDER,
            }
            : {
              kind: 'permission_resolved',
              requestId,
              sessionId: turn.sessionId,
              provider: PROVIDER,
            },
        ));
        resolve(response);
      };

      const pending: PendingPermission = {
        requestId,
        turnKey: key,
        sessionId: turn.sessionId,
        toolName: resolvedToolName,
        input: toolInput,
        context: {
          // Full options, so an answered request can pick by kind afterwards.
          options: request.options,
          title: request.toolCall.title,
          kind: request.toolCall.kind,
        },
        receivedAt: Date.now(),
        finish,
      };
      pendingPermissions.set(requestId, pending);

      send(createNormalizedMessage({
        kind: 'permission_request',
        requestId,
        toolName: resolvedToolName,
        input: toolInput,
        context: pending.context,
        sessionId: turn.sessionId,
        provider: PROVIDER,
      }));

      timer = setTimeout(() => {
        finish({ outcome: { outcome: 'cancelled' } }, 'Permission request timed out.');
      }, PERMISSION_TIMEOUT_MS);
    });
  };

  try {
    const client = await KimiAcpClient.start({
      onSessionUpdate: forwardUpdate,
      onPermissionRequest: handlePermission,
    });
    turn.client = client;

    await client.initialize();

    let session: acp.NewSessionResponse | acp.ResumeSessionResponse;
    let providerSessionId: string;
    if (resumeSessionId) {
      // `session/resume` echoes the configuration but not the id, so the id the
      // caller resumed with is the one every later request addresses.
      session = await client.resumeSession(resumeSessionId, cwd);
      providerSessionId = resumeSessionId;
    } else {
      const created = await client.newSession(cwd);
      session = created;
      providerSessionId = created.sessionId;
    }
    turn.providerSessionId = providerSessionId;

    if (!resumeSessionId) {
      // The writer maps this provider id onto the app session row and the
      // session_created row is swallowed by the gateway on purpose.
      writer.setSessionId?.(providerSessionId);
      send(createNormalizedMessage({
        kind: 'session_created',
        newSessionId: providerSessionId,
        sessionId: providerSessionId,
        provider: PROVIDER,
      }));
    }

    const resolvedModel = await context.resolveResumeModel(appSessionId ?? undefined, options.model);
    await applySessionSettings(client, providerSessionId, session, {
      model: resolvedModel,
      effort: options.effort,
      permissionMode: options.permissionMode,
    });

    if (turn.aborted) {
      return;
    }

    const promptBlocks = await buildPromptBlocks(command, options.images);
    turn.promptSettled = new Promise<void>((resolve) => {
      turn.resolvePromptSettled = resolve;
    });

    await client.prompt(providerSessionId, promptBlocks);

    flushThought();
    closeStream();

    // The caller's abort path owns the terminal completion for cancelled turns.
    if (turn.aborted) {
      return;
    }

    send(createCompleteMessage({
      provider: PROVIDER,
      sessionId: turn.sessionId,
      actualSessionId: turn.sessionId,
      exitCode: 0,
    }));
  } catch (error) {
    if (turn.aborted) {
      return;
    }

    const normalized = toKimiAcpError(error, turn.client?.getStderrTail() ?? '');
    if (!protocolErrorSent) {
      sendError(normalized.message);
      send(createCompleteMessage({
        provider: PROVIDER,
        sessionId: turn.sessionId,
        actualSessionId: turn.sessionId,
        exitCode: 1,
      }));
    }
  } finally {
    flushThought();
    closeStream();
    settleTurnPermissions(key, 'Turn ended before the permission was answered.');

    const client = turn.client;
    turn.client = null;
    if (client) {
      await client.close(turn.providerSessionId ?? undefined).catch(() => client.kill());
    }

    turn.resolvePromptSettled?.();
    if (activeTurns.get(key) === turn) {
      activeTurns.delete(key);
    }
  }
}

/**
 * Maps CloudCLI's permission mode onto a mode Kimi actually advertises.
 *
 * The ids are read from the session response rather than hard-coded: Kimi
 * today calls them `default`, `yolo`, `auto`, and `plan`, but the resolver
 * accepts the documented aliases too. `plan` never downgrades — if the agent
 * does not offer a plan mode the turn fails with an explicit error.
 */
export function resolveKimiPermissionMode(
  modes: acp.SessionModeState | null | undefined,
  requestedMode: unknown,
): string | null {
  const requested = typeof requestedMode === 'string' && requestedMode ? requestedMode : 'default';
  const available = (modes?.availableModes ?? []).map((mode) => mode.id);
  if (available.length === 0) {
    if (requested === 'plan') {
      throw new AppError(
        'Kimi Code CLI does not advertise a plan mode; switch to another permission mode.',
        { code: 'KIMI_PLAN_MODE_UNAVAILABLE', statusCode: 400 },
      );
    }
    return null;
  }

  const candidates: Record<string, string[]> = {
    default: ['manual', 'default', 'ask'],
    acceptEdits: ['yolo', 'acceptEdits', 'accept_edits'],
    bypassPermissions: ['auto', 'bypassPermissions', 'bypass', 'never_ask'],
    plan: ['plan'],
  };
  const preferred = candidates[requested] ?? candidates.default;

  for (const candidate of preferred) {
    if (available.includes(candidate)) {
      return candidate;
    }
  }

  if (requested === 'plan') {
    throw new AppError(
      'Kimi Code CLI does not advertise a plan mode; switch to another permission mode.',
      { code: 'KIMI_PLAN_MODE_UNAVAILABLE', statusCode: 400 },
    );
  }

  return null;
}

/** Chooses an advertised option by kind; never guesses an option id. */
function selectPermissionOutcome(
  options: acp.PermissionOption[],
  decision: { allow: boolean; remember?: boolean },
): acp.RequestPermissionResponse {
  const wantedKinds = decision.allow
    ? decision.remember
      ? ['allow_always', 'allow_once']
      : ['allow_once', 'allow_always']
    : decision.remember
      ? ['reject_always', 'reject_once']
      : ['reject_once', 'reject_always'];

  for (const kind of wantedKinds) {
    const option = options.find((candidate) => candidate.kind === kind);
    if (option) {
      return { outcome: { outcome: 'selected', optionId: option.optionId } };
    }
  }

  return { outcome: { outcome: 'cancelled' } };
}

/**
 * Decides whether a request can be answered without the UI.
 *
 * Order matters: an explicit disallow rule always wins, then session-scoped
 * "always allow" memory, then an explicit allow rule, then the session mode.
 */
function resolveAutomaticPermission(
  options: AnyRecord,
  appSessionId: string,
  toolName: string,
  toolInput: unknown,
): { allow: boolean; remember?: boolean } | null {
  const toolsSettings = readObjectRecord(options.toolsSettings) ?? {};
  const disallowed = Array.isArray(toolsSettings.disallowedTools)
    ? toolsSettings.disallowedTools.filter((entry): entry is string => typeof entry === 'string')
    : [];
  if (disallowed.some((entry) => matchesToolRule(entry, toolName, toolInput))) {
    return { allow: false };
  }

  const permissionMode = typeof options.permissionMode === 'string' ? options.permissionMode : 'default';
  if (permissionMode === 'bypassPermissions') {
    return { allow: true };
  }
  if (permissionMode === 'acceptEdits' && isEditToolName(toolName)) {
    return { allow: true };
  }

  const remembered = rememberedToolApprovals.get(appSessionId);
  if (remembered?.has(toolName)) {
    return { allow: true };
  }

  const allowed = Array.isArray(toolsSettings.allowedTools)
    ? toolsSettings.allowedTools.filter((entry): entry is string => typeof entry === 'string')
    : [];
  if (allowed.some((entry) => matchesToolRule(entry, toolName, toolInput))) {
    return { allow: true };
  }

  return null;
}

/** Kimi's edit-ish tool names; used to honour `acceptEdits`. */
function isEditToolName(toolName: string): boolean {
  return /^(Edit|Write|MultiEdit|ApplyPatch|NotebookEdit)$/i.test(toolName);
}

/**
 * Matches one Claude-style tool rule (`Read`, `Bash(git:*)`, `*`) against an
 * ACP tool call.
 *
 * This is Kimi's single-use matcher: it deliberately does not share Claude's
 * private implementation, which is coupled to Claude's tool input shapes.
 */
function matchesToolRule(entry: string, toolName: string, toolInput: unknown): boolean {
  const rule = entry.trim();
  if (!rule) {
    return false;
  }
  if (rule === '*' || rule === toolName) {
    return true;
  }

  const commandMatch = rule.match(/^([^()]+)\((.+):\*\)$/);
  if (!commandMatch) {
    return rule.toLowerCase() === toolName.toLowerCase();
  }

  const [, ruleToolName, prefix] = commandMatch;
  if (ruleToolName !== toolName) {
    return false;
  }
  const command = readObjectRecord(toolInput)?.command;
  return typeof command === 'string' && command.trim().startsWith(prefix);
}

/** Applies model, thinking level, and permission mode to a fresh/resumed session. */
async function applySessionSettings(
  client: KimiAcpClient,
  sessionId: string,
  session: acp.NewSessionResponse | acp.ResumeSessionResponse,
  settings: { model?: unknown; effort?: unknown; permissionMode?: unknown },
): Promise<void> {
  const configOptions = session.configOptions ?? [];
  const modelOption = findConfigOption(configOptions, 'model');
  const thinkingOption = findConfigOption(configOptions, 'thought_level');

  const requestedModel = typeof settings.model === 'string' ? settings.model.trim() : '';
  if (requestedModel && modelOption && configOptionValues(modelOption).includes(requestedModel)) {
    await client.setSessionConfigOption(sessionId, modelOption.id, requestedModel);
  }

  const requestedEffort = typeof settings.effort === 'string' ? settings.effort.trim() : '';
  if (requestedEffort && thinkingOption && configOptionValues(thinkingOption).includes(requestedEffort)) {
    await client.setSessionConfigOption(sessionId, thinkingOption.id, requestedEffort);
  }

  const modeId = resolveKimiPermissionMode(session.modes, settings.permissionMode);
  if (modeId && modeId !== session.modes?.currentModeId) {
    await client.setSessionMode(sessionId, modeId);
  }
}

function findConfigOption(
  options: acp.SessionConfigOption[],
  category: string,
): acp.SessionConfigOption | undefined {
  return options.find((option) => option.category === category)
    ?? options.find((option) => option.id === category);
}

function configOptionValues(option: acp.SessionConfigOption): string[] {
  if (option.type !== 'select') {
    return [];
  }

  return option.options.flatMap((entry) => (
    'group' in entry && Array.isArray((entry as AnyRecord).options)
      ? ((entry as AnyRecord).options as AnyRecord[]).map((nested) => String(nested.value ?? ''))
      : [String((entry as AnyRecord).value ?? '')]
  ));
}

/** Builds ACP prompt content: text plus any uploaded images read from disk. */
async function buildPromptBlocks(
  command: string,
  images: unknown,
): Promise<acp.ContentBlock[]> {
  const blocks: acp.ContentBlock[] = [];
  if (command) {
    blocks.push({ type: 'text', text: command });
  }

  for (const image of Array.isArray(images) ? images : []) {
    const record = readObjectRecord(image);
    const imagePath = typeof record?.path === 'string' ? record.path : '';
    if (!imagePath) {
      continue;
    }

    try {
      const data = await readFile(imagePath);
      const mimeType = typeof record?.mimeType === 'string' && record.mimeType
        ? record.mimeType
        : mime.lookup(path.extname(imagePath)) || 'image/png';
      blocks.push({
        type: 'image',
        data: data.toString('base64'),
        mimeType,
      });
    } catch (error) {
      console.warn(`[Kimi] Skipping unreadable image attachment ${path.basename(imagePath)}:`, error);
    }
  }

  if (blocks.length === 0) {
    blocks.push({ type: 'text', text: '' });
  }

  return blocks;
}

/** Sends `session/cancel`, waits briefly for the turn to unwind, then kills it. */
async function abortKimiSession(sessionId: string): Promise<boolean> {
  const turn = activeTurns.get(sessionId)
    ?? Array.from(activeTurns.values()).find((candidate) => candidate.providerSessionId === sessionId);
  if (!turn) {
    return false;
  }

  if (turn.aborted) {
    return true;
  }
  turn.aborted = true;

  settleTurnPermissions(turn.key, 'Turn cancelled by the user.');

  const client = turn.client;
  if (client && turn.providerSessionId) {
    await client.cancel(turn.providerSessionId).catch(() => undefined);
  }

  // The run's finally closes the client. If the agent does not wind down, the
  // process is killed so `chat.abort` never leaves a live `kimi acp` behind.
  const settled = turn.promptSettled ?? Promise.resolve();
  const timeout = new Promise<void>((resolve) => {
    setTimeout(resolve, ABORT_SETTLE_TIMEOUT_MS);
  });
  await Promise.race([settled, timeout]);
  if (activeTurns.get(turn.key) === turn && client) {
    client.kill();
  }

  return true;
}

/** Fails every pending permission request that belongs to one turn. */
function settleTurnPermissions(turnKey: string, reason: string): void {
  for (const pending of pendingPermissions.values()) {
    if (pending.turnKey === turnKey) {
      pending.finish({ outcome: { outcome: 'cancelled' } }, reason);
    }
  }
}

function resolveKimiPermission(
  requestId: string,
  decision: ProviderPermissionDecision,
): void {
  const pending = pendingPermissions.get(requestId);
  if (!pending) {
    return;
  }

  if (decision.allow && decision.rememberEntry) {
    const remembered = rememberedToolApprovals.get(pending.sessionId) ?? new Set<string>();
    remembered.add(pending.toolName);
    rememberedToolApprovals.set(pending.sessionId, remembered);
  }

  const response = selectPermissionOutcome(
    pending.context && Array.isArray((pending.context as AnyRecord).options)
      ? ((pending.context as AnyRecord).options as acp.PermissionOption[])
      : [],
    { allow: decision.allow, remember: Boolean(decision.rememberEntry) },
  );
  pending.finish(response);
}

function listPendingKimiPermissions(sessionId: string): unknown[] {
  return Array.from(pendingPermissions.values())
    .filter((pending) => pending.sessionId === sessionId)
    .map((pending) => ({
      requestId: pending.requestId,
      toolName: pending.toolName,
      input: pending.input,
      context: pending.context,
      sessionId: pending.sessionId,
      receivedAt: pending.receivedAt,
    }));
}

/** Forgets session-scoped approvals, e.g. when the app session is deleted. */
export function clearKimiToolApprovals(appSessionId: string): void {
  rememberedToolApprovals.delete(appSessionId);
}

/**
 * Closes every live ACP process and login child.
 *
 * Called from the server shutdown path through the providers barrel so no
 * `kimi acp` outlives the backend.
 */
export async function closeKimiRuntime(): Promise<void> {
  kimiLoginService.close();
  const turns = Array.from(activeTurns.values());
  for (const turn of turns) {
    turn.aborted = true;
    settleTurnPermissions(turn.key, 'CloudCLI is shutting down.');
    turn.client?.kill();
  }
  activeTurns.clear();
  pendingPermissions.clear();
  rememberedToolApprovals.clear();
}

let exitHookInstalled = false;
function installExitHook(): void {
  if (exitHookInstalled) {
    return;
  }
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const turn of activeTurns.values()) {
      turn.client?.kill();
    }
  });
}

export const kimiRuntime: IProviderRuntime = {
  run: runKimiTurn,
  abort: abortKimiSession,
  permissions: {
    resolve: resolveKimiPermission,
    listPending: listPendingKimiPermissions,
  },
};