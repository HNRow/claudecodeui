import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

import type { NormalizedMessage } from '@/shared/types.js';
import {
  createNormalizedMessage,
  getKimiSessionsRoot,
  readObjectRecord,
  readOptionalString,
} from '@/shared/utils.js';

type WireRecord = Record<string, unknown>;

type StoredWireRecord = {
  record: WireRecord;
  lineNumber: number;
};

type WireMessageInput = {
  kind: NormalizedMessage['kind'];
  role?: NormalizedMessage['role'];
  content?: string;
  toolId?: string;
  toolName?: string;
  toolInput?: unknown;
  status?: string;
  isError?: boolean;
};

/** Used by KimiSessionsProvider to recover history when Kimi cannot replay a session. */
export async function loadKimiWireHistory(providerSessionId: string): Promise<NormalizedMessage[]> {
  const wirePath = await findKimiMainWirePath(providerSessionId);
  if (!wirePath) {
    throw new Error(`Kimi wire history was not found for ${providerSessionId}.`);
  }

  const records = await readWireRecords(wirePath);
  const anchorTime = await readSessionUpdatedAt(wirePath);
  return buildWireHistoryMessages(records, providerSessionId, anchorTime);
}

/** Used by Kimi history and liveness adapters to locate the provider's main-agent log. */
export async function findKimiMainWirePath(providerSessionId: string): Promise<string | null> {
  let workspaces;
  try {
    workspaces = await readdir(getKimiSessionsRoot(), { withFileTypes: true });
  } catch {
    return null;
  }

  for (const workspace of workspaces.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!workspace.isDirectory()) {
      continue;
    }
    const wirePath = path.join(
      getKimiSessionsRoot(),
      workspace.name,
      providerSessionId,
      'agents',
      'main',
      'wire.jsonl',
    );
    try {
      if ((await stat(wirePath)).isFile()) {
        return wirePath;
      }
    } catch {
      // This workspace does not contain the requested session.
    }
  }

  return null;
}

/** Parses wire JSONL incrementally, retaining source line numbers and skipping malformed rows. */
async function readWireRecords(wirePath: string): Promise<StoredWireRecord[]> {
  const records: StoredWireRecord[] = [];
  const input = createReadStream(wirePath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;

  try {
    for await (const line of lines) {
      lineNumber += 1;
      if (!line.trim()) {
        continue;
      }
      try {
        const record = readObjectRecord(JSON.parse(line));
        if (record) {
          records.push({ record, lineNumber });
        }
      } catch {
        // A partial final line or an older malformed row must not hide the rest.
      }
    }
  } finally {
    lines.close();
    input.destroy();
  }

  return records;
}

/** Reads the session's last-update time to anchor records that have no timestamp. */
async function readSessionUpdatedAt(wirePath: string): Promise<number | undefined> {
  try {
    const statePath = path.join(path.dirname(wirePath), '..', '..', 'state.json');
    const state = readObjectRecord(JSON.parse(await readFile(statePath, 'utf8')));
    return typeof state?.updatedAt === 'number' && Number.isFinite(state.updatedAt)
      ? state.updatedAt
      : undefined;
  } catch {
    return undefined;
  }
}

/** Converts supported wire records into normalized transcript rows in source order. */
function buildWireHistoryMessages(
  records: StoredWireRecord[],
  providerSessionId: string,
  anchorTime?: number,
): NormalizedMessage[] {
  const messages: NormalizedMessage[] = [];
  const fallbackAnchor = anchorTime ?? Date.now();

  // Adds one row with a stable source-derived ID and a real or deterministic timestamp.
  const pushMessage = (
    record: StoredWireRecord,
    recordIndex: number,
    input: WireMessageInput,
  ) => {
    const recordTime = record.record.time;
    const timestamp = typeof recordTime === 'number' && Number.isFinite(recordTime)
      ? recordTime
      : fallbackAnchor - (records.length - recordIndex) * 1_000;
    messages.push(createNormalizedMessage({
      ...input,
      kind: input.kind,
      id: `kimi_wire_${providerSessionId}_${record.lineNumber}_${input.kind}`,
      sessionId: providerSessionId,
      timestamp: new Date(timestamp).toISOString(),
      provider: 'kimi',
    }));
  };

  records.forEach((stored, recordIndex) => {
    const { record } = stored;
    if (record.type === 'context.append_message') {
      appendUserMessage(stored, recordIndex, pushMessage);
      return;
    }
    if (record.type !== 'context.append_loop_event') {
      return;
    }

    const event = readObjectRecord(record.event);
    if (!event) {
      return;
    }
    if (event.type === 'content.part') {
      appendAssistantPart(stored, recordIndex, event, pushMessage);
    } else if (event.type === 'tool.call') {
      appendToolCall(stored, recordIndex, event, pushMessage);
    } else if (event.type === 'tool.result') {
      appendToolResult(stored, recordIndex, event, pushMessage);
    }
  });

  return messages;
}

type PushWireMessage = (
  record: StoredWireRecord,
  recordIndex: number,
  input: WireMessageInput,
) => void;

/** Emits only genuine user-originated text, excluding injected reminders and plugin context. */
function appendUserMessage(
  stored: StoredWireRecord,
  recordIndex: number,
  pushMessage: PushWireMessage,
): void {
  const message = readObjectRecord(stored.record.message);
  if (
    message?.role !== 'user'
    || readObjectRecord(message.origin)?.kind !== 'user'
    || !Array.isArray(message.content)
  ) {
    return;
  }

  const content = message.content
    .map((part) => readObjectRecord(part))
    .filter((part) => part?.type === 'text' && typeof part.text === 'string' && part.text.length > 0)
    .map((part) => part?.text as string)
    .join('\n');
  if (content) {
    pushMessage(stored, recordIndex, { kind: 'text', role: 'user', content });
  }
}

/** Converts a persisted assistant text or thinking part into one transcript row. */
function appendAssistantPart(
  stored: StoredWireRecord,
  recordIndex: number,
  event: WireRecord,
  pushMessage: PushWireMessage,
): void {
  const part = readObjectRecord(event.part);
  if (part?.type === 'text' && typeof part.text === 'string' && part.text) {
    pushMessage(stored, recordIndex, { kind: 'text', role: 'assistant', content: part.text });
  } else if (part?.type === 'think' && typeof part.think === 'string' && part.think) {
    pushMessage(stored, recordIndex, { kind: 'thinking', role: 'assistant', content: part.think });
  }
}

/** Converts a persisted tool invocation into the normalized tool-use row. */
function appendToolCall(
  stored: StoredWireRecord,
  recordIndex: number,
  event: WireRecord,
  pushMessage: PushWireMessage,
): void {
  const toolId = readOptionalString(event.toolCallId);
  if (!toolId) {
    return;
  }
  pushMessage(stored, recordIndex, {
    kind: 'tool_use',
    toolId,
    toolName: readOptionalString(event.name) ?? 'Tool',
    toolInput: event.args ?? {},
    status: 'in_progress',
  });
}

/** Converts a persisted tool outcome into the result row linked by tool-call ID. */
function appendToolResult(
  stored: StoredWireRecord,
  recordIndex: number,
  event: WireRecord,
  pushMessage: PushWireMessage,
): void {
  const toolId = readOptionalString(event.toolCallId);
  if (!toolId) {
    return;
  }
  const result = readObjectRecord(event.result);
  const output = result ? result.output ?? result.error : event.result;
  pushMessage(stored, recordIndex, {
    kind: 'tool_result',
    toolId,
    content: stringifyOutput(output),
    isError: result?.isError === true || typeof result?.error === 'string',
  });
}

/** Formats structured tool output for the existing text-oriented result renderer. */
function stringifyOutput(output: unknown): string {
  if (typeof output === 'string') {
    return output;
  }
  if (output === undefined || output === null) {
    return '';
  }
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}
