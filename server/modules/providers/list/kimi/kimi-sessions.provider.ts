import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import type * as acp from '@agentclientprotocol/sdk';

import type { IProviderSessions } from '@/shared/interfaces.js';
import type {
  FetchHistoryOptions,
  FetchHistoryResult,
  NormalizedMessage,
} from '@/shared/types.js';
import {
  createNormalizedMessage,
  getKimiSessionsRoot,
  isKimiSessionId,
  readObjectRecord,
  readOptionalString,
  sliceTailPage,
} from '@/shared/utils.js';
import { KimiAcpClient, toKimiAcpError } from '@/modules/providers/list/kimi/kimi-acp.client.js';
import { loadKimiWireHistory } from '@/modules/providers/list/kimi/kimi-wire-history.js';

const PROVIDER = 'kimi' as const;
/** A history replay is a full read; it may take longer than one RPC. */
const HISTORY_LOAD_TIMEOUT_MS = 120_000;

/** Raw envelope the Kimi runtime hands to `normalizeMessage`. */
export type KimiUpdateEnvelope = {
  update: acp.SessionUpdate;
  /** True when the update comes from `session/load` replay rather than a live turn. */
  historical?: boolean;
  /** Position in the source stream, used to keep generated ids unique. */
  sequence?: number;
};

type KimiSessionsProviderOptions = {
  loadAcpHistory?: typeof loadKimiHistory;
  loadWireHistory?: typeof loadKimiWireHistory;
};

/**
 * Session/history adapter for Kimi's ACP sessions.
 *
 * Both the live runtime and `fetchHistory` funnel through the same
 * `normalizeMessage`, so a tool call renders identically whether it arrived
 * over the websocket or was replayed by `session/load`.
 */
export class KimiSessionsProvider implements IProviderSessions {
  private readonly loadAcpHistory: typeof loadKimiHistory;
  private readonly loadWireHistory: typeof loadKimiWireHistory;

  /** Allows focused tests to substitute history transports without spawning Kimi. */
  constructor({
    loadAcpHistory = loadKimiHistory,
    loadWireHistory = loadKimiWireHistory,
  }: KimiSessionsProviderOptions = {}) {
    this.loadAcpHistory = loadAcpHistory;
    this.loadWireHistory = loadWireHistory;
  }

  normalizeMessage(raw: unknown, sessionId: string | null): NormalizedMessage[] {
    const record = readObjectRecord(raw);
    if (!record) {
      return [];
    }

    const update = readObjectRecord(record.update) ?? record;
    const historical = record.historical === true;
    const sequence = typeof record.sequence === 'number' ? record.sequence : 0;
    return normalizeKimiSessionUpdate(update as acp.SessionUpdate, {
      sessionId,
      historical,
      sequence,
    });
  }

  /** Replays history through ACP, falling back to the persisted main-agent wire log. */
  async fetchHistory(sessionId: string, options: FetchHistoryOptions = {}): Promise<FetchHistoryResult> {
    const providerSessionId = options.providerSessionId ?? sessionId;
    const limit = options.limit === undefined ? null : options.limit;
    const offset = options.offset ?? 0;

    if (!isKimiSessionId(providerSessionId)) {
      return { messages: [], total: 0, hasMore: false, offset, limit };
    }

    let messages: NormalizedMessage[];
    try {
      messages = await this.loadAcpHistory(providerSessionId, options.projectPath);
    } catch (acpError) {
      console.warn('[Kimi] ACP history failed; trying wire fallback:', formatKimiError(acpError));
      try {
        messages = await this.loadWireHistory(providerSessionId);
      } catch (fallbackError) {
        console.warn('[Kimi] Wire history fallback failed:', formatKimiError(fallbackError));
        throw acpError;
      }
      if (messages.length === 0) {
        throw acpError;
      }
    }

    const total = messages.length;
    if (limit === 0) {
      return { messages: [], total, hasMore: total > 0, offset, limit };
    }

    const { page, hasMore } = sliceTailPage(messages, limit, offset);
    return { messages: page, total, hasMore, offset, limit };
  }
}

/**
 * Converts one ACP session update into normalized transcript rows.
 *
 * Live and historical modes differ only in how text chunks are framed:
 * `session/load` replays complete messages, while a live turn streams deltas
 * that the chat client accumulates until `stream_end`.
 */
export function normalizeKimiSessionUpdate(
  update: acp.SessionUpdate,
  options: { sessionId: string | null; historical: boolean; sequence: number },
): NormalizedMessage[] {
  const { sessionId, historical, sequence } = options;

  switch (update.sessionUpdate) {
    case 'user_message_chunk': {
      // The sending client already rendered its own user message; history
      // replay is the only place these chunks become transcript rows.
      if (!historical) {
        return [];
      }
      const text = readContentText(update.content);
      if (!text || isInjectedUserContext(text)) {
        return [];
      }
      return [textMessage('user', text, sessionId, update, sequence)];
    }

    case 'agent_message_chunk': {
      const text = readContentText(update.content);
      if (!text) {
        return [];
      }
      if (historical) {
        return [textMessage('assistant', text, sessionId, update, sequence)];
      }
      return [createNormalizedMessage({
        id: `kimi_stream_${sessionId ?? 'session'}`,
        kind: 'stream_delta',
        content: text,
        sessionId,
        provider: PROVIDER,
      })];
    }

    case 'agent_thought_chunk': {
      const text = readContentText(update.content);
      if (!text) {
        return [];
      }
      return [createNormalizedMessage({
        id: messageRowId('think', update, sequence, sessionId),
        kind: 'thinking',
        content: text,
        role: 'assistant',
        sessionId,
        provider: PROVIDER,
      })];
    }

    case 'tool_call':
      return [toToolUseMessage(update, sessionId)];

    case 'tool_call_update':
      return toToolResultMessages(update, sessionId);

    case 'plan':
      return toPlanMessage(update, sessionId, sequence);

    case 'usage_update': {
      const used = Number(update.used);
      const total = Number(update.size);
      if (!Number.isFinite(used) || used < 0) {
        return [];
      }
      return [createNormalizedMessage({
        kind: 'status',
        text: 'token_budget',
        tokenBudget: {
          used,
          total: Number.isFinite(total) && total > 0 ? total : undefined,
          inputTokens: used,
          outputTokens: 0,
          breakdown: { input: used },
        },
        sessionId,
        provider: PROVIDER,
      })];
    }

    case 'current_mode_update':
      // The runtime already applied the mode it asked for; a status row here
      // would only flash a raw mode id in the composer's activity banner.
      return [];

    case 'config_option_update':
      return [];

    case 'available_commands_update':
      return [];

    case 'session_info_update':
      return [];

    default:
      return [];
  }
}

/**
 * Replays one Kimi session through a short-lived ACP process.
 *
 * The connection is always closed, including when `session/load` fails, so a
 * history read can never leave a `kimi acp` process behind.
 */
export async function loadKimiHistory(
  providerSessionId: string,
  projectPath?: string,
): Promise<NormalizedMessage[]> {
  const cwd = projectPath?.trim() || process.cwd();
  const updates: acp.SessionUpdate[] = [];
  const client = await KimiAcpClient.start({
    onSessionUpdate: (update) => {
      updates.push(update);
    },
    onPermissionRequest: async () => ({ outcome: { outcome: 'cancelled' } }),
  });

  try {
    await client.initialize();
    await client.loadSession(providerSessionId, cwd);
  } catch (error) {
    throw toKimiAcpError(error, client.getStderrTail());
  } finally {
    await client.close(providerSessionId);
  }

  // ACP carries no timestamps. Anchor the replay to the session's own last
  // update so these rows sort before the live turn instead of jumping to the
  // bottom of the transcript on every refresh.
  const anchorTime = await readKimiSessionUpdatedAt(providerSessionId);
  return buildHistoryMessages(updates, providerSessionId, anchorTime ?? undefined);
}

/** Reads `updatedAt` from the session's `state.json`; null when unavailable. */
async function readKimiSessionUpdatedAt(sessionId: string): Promise<number | null> {
  const sessionsRoot = getKimiSessionsRoot();
  let groups;
  try {
    groups = await readdir(sessionsRoot, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const group of groups) {
    if (!group.isDirectory()) {
      continue;
    }
    try {
      const content = await readFile(
        path.join(sessionsRoot, group.name, sessionId, 'state.json'),
        'utf8',
      );
      const updatedAt = readObjectRecord(JSON.parse(content))?.updatedAt;
      if (typeof updatedAt === 'number' && Number.isFinite(updatedAt)) {
        return updatedAt;
      }
    } catch {
      // Not this group; keep looking.
    }
  }

  return null;
}

/** Folds replayed update chunks into complete transcript rows, in order. */
export function buildHistoryMessages(
  updates: acp.SessionUpdate[],
  providerSessionId: string,
  anchorTime?: number,
): NormalizedMessage[] {
  const messages: NormalizedMessage[] = [];
  // One second per update ending at the anchor (the session's last update).
  const baseTime = (anchorTime ?? Date.now()) - updates.length * 1_000;
  let pending: { key: string; kind: 'text' | 'thinking'; role: 'user' | 'assistant'; text: string; timestamp: string } | null = null;

  const timestampFor = (index: number) => new Date(baseTime + index * 1_000).toISOString();
  const flush = () => {
    if (!pending) {
      return;
    }
    const { kind, role, text, timestamp } = pending;
    pending = null;
    if (kind === 'text' && role === 'user' && isInjectedUserContext(text)) {
      return;
    }
    const index = messages.length;
    messages.push(createNormalizedMessage({
      id: `kimi_${providerSessionId}_${index}_${kind}`,
      kind,
      role,
      content: text,
      timestamp,
      sessionId: providerSessionId,
      provider: PROVIDER,
    }));
  };

  updates.forEach((update, index) => {
    const updateType = update.sessionUpdate;
    const messageId = 'messageId' in update && typeof update.messageId === 'string'
      ? update.messageId
      : `seq${index}`;

    if (updateType === 'user_message_chunk' || updateType === 'agent_message_chunk') {
      const text = readContentText(update.content);
      if (!text) {
        return;
      }
      const kind = 'text' as const;
      const role = updateType === 'user_message_chunk' ? 'user' as const : 'assistant' as const;
      const key = `${updateType}:${messageId}`;
      if (pending && pending.key === key) {
        pending.text += text;
      } else {
        flush();
        pending = { key, kind, role, text, timestamp: timestampFor(index) };
      }
      return;
    }

    if (updateType === 'agent_thought_chunk') {
      const text = readContentText(update.content);
      if (!text) {
        return;
      }
      const key = `thought:${messageId}`;
      if (pending && pending.key === key) {
        pending.text += text;
      } else {
        flush();
        pending = { key, kind: 'thinking', role: 'assistant', text, timestamp: timestampFor(index) };
      }
      return;
    }

    flush();
    for (const message of normalizeKimiSessionUpdate(update, {
      sessionId: providerSessionId,
      historical: true,
      sequence: index,
    })) {
      messages.push({
        ...message,
        id: `kimi_${providerSessionId}_${index}_${message.kind}`,
        timestamp: timestampFor(index),
      });
    }
  });
  flush();

  return messages;
}

/** Tags Kimi prepends to synthetic user turns (reminders, plugin bootstrap). */
const INJECTED_USER_CONTEXT_PREFIXES = [
  '<system-reminder>',
  '<plugin_session_start',
  '<plugin-instructions',
  '<files_input>',
  '<images_input>',
];

/**
 * True for a user row Kimi injected into the conversation.
 *
 * Kimi replays its own system reminders and plugin bootstrap prompts as user
 * messages through `session/load`; showing them would dump a wall of internal
 * instructions into the transcript.
 */
function isInjectedUserContext(text: string): boolean {
  const normalized = text.trimStart().toLowerCase();
  return INJECTED_USER_CONTEXT_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function textMessage(
  role: 'user' | 'assistant',
  text: string,
  sessionId: string | null,
  update: acp.ContentChunk,
  sequence: number,
): NormalizedMessage {
  return createNormalizedMessage({
    id: messageRowId('text', update, sequence, sessionId),
    kind: 'text',
    role,
    content: text,
    sessionId,
    provider: PROVIDER,
  });
}

function messageRowId(
  prefix: string,
  update: acp.ContentChunk,
  sequence: number,
  sessionId: string | null,
): string {
  const messageId = typeof update.messageId === 'string' && update.messageId
    ? update.messageId
    : `seq${sequence}`;
  return `kimi_${prefix}_${sessionId ?? 'session'}_${messageId}`;
}

function toToolUseMessage(toolCall: acp.ToolCall, sessionId: string | null): NormalizedMessage {
  const toolName = readOptionalString(toolCall.name)
    ?? readOptionalString(toolCall.title)
    ?? toolCall.kind
    ?? 'Tool';

  return createNormalizedMessage({
    id: `kimi_tool_${toolCall.toolCallId}`,
    kind: 'tool_use',
    toolId: toolCall.toolCallId,
    toolName,
    toolInput: toolCall.rawInput ?? { title: toolCall.title },
    status: toolCall.status,
    sessionId,
    provider: PROVIDER,
  });
}

/**
 * Turns a terminal tool-call update into the tool result that attaches to the
 * `tool_use` carrying the same id.
 *
 * Non-terminal updates only carry progress; emitting them would append a second
 * row for the same call, so they are dropped and the start row stays the one
 * entry the UI updates.
 */
function toToolResultMessages(
  update: acp.ToolCallUpdate,
  sessionId: string | null,
): NormalizedMessage[] {
  if (update.status !== 'completed' && update.status !== 'failed') {
    return [];
  }

  const content = readToolCallContent(update.content, update.rawOutput);
  return [createNormalizedMessage({
    id: `kimi_tool_result_${update.toolCallId}`,
    kind: 'tool_result',
    toolId: update.toolCallId,
    content,
    isError: update.status === 'failed',
    sessionId,
    provider: PROVIDER,
  })];
}

function toPlanMessage(
  plan: acp.Plan,
  sessionId: string | null,
  sequence: number,
): NormalizedMessage[] {
  const entries = Array.isArray(plan.entries) ? plan.entries : [];
  const todos = entries.map((entry) => ({
    content: entry.content,
    status: entry.status,
    priority: entry.priority,
  }));

  return [createNormalizedMessage({
    id: `kimi_plan_${sessionId ?? 'session'}_${sequence}`,
    kind: 'tool_use',
    toolId: `kimi-plan-${sequence}`,
    toolName: 'TodoWrite',
    toolInput: { todos },
    sessionId,
    provider: PROVIDER,
  })];
}

function readContentText(content: acp.ContentBlock | undefined): string {
  const record = readObjectRecord(content);
  if (!record || record.type !== 'text') {
    return '';
  }
  return typeof record.text === 'string' ? record.text : '';
}

function readToolCallContent(
  content: acp.ToolCallContent[] | null | undefined,
  rawOutput: unknown,
): string {
  const parts: string[] = [];
  for (const entry of content ?? []) {
    const record = readObjectRecord(entry);
    if (!record) {
      continue;
    }
    if (record.type === 'content') {
      const inner = readObjectRecord(record.content);
      if (inner?.type === 'text' && typeof inner.text === 'string') {
        parts.push(inner.text);
      }
      continue;
    }
    if (record.type === 'diff') {
      const pathText = readOptionalString(record.path) ?? 'file';
      const diffText = readOptionalString(record.newText);
      parts.push(diffText ? `${pathText}\n${diffText}` : pathText);
      continue;
    }
    if (record.type === 'terminal') {
      parts.push(`[terminal ${readOptionalString(record.terminalId) ?? ''}]`.trim());
    }
  }

  if (parts.length > 0) {
    return parts.join('\n\n');
  }
  if (typeof rawOutput === 'string') {
    return rawOutput;
  }
  if (rawOutput !== undefined && rawOutput !== null) {
    try {
      return JSON.stringify(rawOutput, null, 2);
    } catch {
      return String(rawOutput);
    }
  }

  return '';
}

function formatKimiError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}