import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { McpProvider } from '@/modules/providers/shared/mcp/mcp.provider.js';
import type {
  McpScope,
  ProviderMcpServer,
  UpsertProviderMcpServerInput,
} from '@/shared/types.js';
import {
  AppError,
  getKimiCodeHome,
  readObjectRecord,
  readOptionalString,
  readStringRecord,
} from '@/shared/utils.js';

const PROVIDER = 'kimi' as const;

/**
 * MCP configuration backed by Kimi Code's native `mcp.json`.
 *
 * Kimi reads one JSON file per scope (`$KIMI_CODE_HOME/mcp.json` for the user,
 * `<workspace>/.kimi-code/mcp.json` for the project) with a top-level
 * `mcpServers` map. Unknown fields on a server — headers, bearer-token env
 * names, timeouts, tool toggles — are preserved on update and returned as read.
 */
export class KimiMcpProvider extends McpProvider {
  constructor() {
    super(PROVIDER, ['user', 'project'], ['stdio', 'http', 'sse']);
  }

  /**
   * Writes one server, merging into its existing entry so fields this form
   * does not model survive an edit.
   */
  async upsertServer(input: UpsertProviderMcpServerInput): Promise<ProviderMcpServer> {
    const scope = input.scope ?? 'project';
    this.assertScopeAndTransport(scope, input.transport);

    const workspacePath = path.resolve(input.workspacePath ?? process.cwd());
    const normalizedName = input.name.trim();
    if (!normalizedName) {
      throw new AppError('MCP server name is required.', {
        code: 'MCP_SERVER_NAME_REQUIRED',
        statusCode: 400,
      });
    }

    const servers = await this.readScopedServers(scope, workspacePath);
    const existing = readObjectRecord(servers[normalizedName]);
    servers[normalizedName] = existing
      ? { ...existing, ...this.buildServerConfig(input) }
      : this.buildServerConfig(input);
    await this.writeScopedServers(scope, workspacePath, servers);

    const normalized = this.normalizeServerConfig(scope, normalizedName, servers[normalizedName]);
    if (!normalized) {
      throw new AppError('MCP server configuration is invalid.', {
        code: 'MCP_SERVER_INVALID',
        statusCode: 400,
      });
    }

    return normalized;
  }

  protected async readScopedServers(
    scope: McpScope,
    workspacePath: string,
  ): Promise<Record<string, unknown>> {
    const config = await readMcpConfig(resolveMcpConfigPath(scope, workspacePath));
    return readObjectRecord(config?.mcpServers) ?? {};
  }

  protected async writeScopedServers(
    scope: McpScope,
    workspacePath: string,
    servers: Record<string, unknown>,
  ): Promise<void> {
    const configPath = resolveMcpConfigPath(scope, workspacePath);
    const config = (await readMcpConfig(configPath)) ?? {};
    config.mcpServers = servers;

    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  }

  protected buildServerConfig(input: UpsertProviderMcpServerInput): Record<string, unknown> {
    if (input.transport === 'stdio') {
      const command = input.command?.trim();
      if (!command) {
        throw new AppError('stdio MCP servers require a command.', {
          code: 'MCP_COMMAND_REQUIRED',
          statusCode: 400,
        });
      }

      return {
        command,
        ...(input.args?.length ? { args: input.args } : {}),
        ...(input.env && Object.keys(input.env).length > 0 ? { env: input.env } : {}),
        ...(input.cwd ? { cwd: input.cwd } : {}),
      };
    }

    const url = input.url?.trim();
    if (!url) {
      throw new AppError(`${input.transport.toUpperCase()} MCP servers require a URL.`, {
        code: 'MCP_URL_REQUIRED',
        statusCode: 400,
      });
    }

    return {
      url,
      ...(input.transport === 'sse' ? { transport: 'sse' as const } : {}),
      ...(input.headers && Object.keys(input.headers).length > 0 ? { headers: input.headers } : {}),
    };
  }

  protected normalizeServerConfig(
    scope: McpScope,
    name: string,
    rawConfig: unknown,
  ): ProviderMcpServer | null {
    const config = readObjectRecord(rawConfig);
    if (!config) {
      return null;
    }

    const url = readOptionalString(config.url);
    const command = readOptionalString(
      typeof config.command === 'string' ? config.command : undefined,
    );
    const transport = readOptionalString(config.transport)?.toLowerCase();
    const headers = readStringRecord(config.headers);

    if (transport === 'sse' || (url && transport !== 'http' && !command)) {
      if (!url) {
        return null;
      }
      return {
        provider: PROVIDER,
        name,
        scope,
        transport: 'sse',
        url,
        headers,
      };
    }

    if (url) {
      return {
        provider: PROVIDER,
        name,
        scope,
        transport: 'http',
        url,
        headers,
        bearerTokenEnvVar: readOptionalString(config.bearerTokenEnvVar)
          ?? readOptionalString(config.bearer_token_env_var),
      };
    }

    if (command) {
      const rawArgs = Array.isArray(config.args)
        ? config.args.filter((arg): arg is string => typeof arg === 'string')
        : undefined;
      return {
        provider: PROVIDER,
        name,
        scope,
        transport: 'stdio',
        command,
        args: rawArgs,
        env: readStringRecord(config.env),
        cwd: readOptionalString(config.cwd),
      };
    }

    return null;
  }
}

/** `user` lives under Kimi's home; `project` under the workspace's `.kimi-code`. */
function resolveMcpConfigPath(scope: McpScope, workspacePath: string): string {
  return scope === 'user'
    ? path.join(getKimiCodeHome(), 'mcp.json')
    : path.join(workspacePath, '.kimi-code', 'mcp.json');
}

/**
 * Parses one `mcp.json`.
 *
 * A missing file is an empty config; malformed JSON throws so the user sees a
 * real error instead of silently losing their servers on the next write.
 */
async function readMcpConfig(configPath: string): Promise<Record<string, unknown> | null> {
  let content: string;
  try {
    content = await readFile(configPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }

  try {
    const parsed = JSON.parse(content) as unknown;
    const record = readObjectRecord(parsed);
    if (!record) {
      throw new Error('root is not an object');
    }
    return record;
  } catch (error) {
    throw new AppError(`Invalid Kimi MCP configuration at ${configPath}: ${(error as Error).message}`, {
      code: 'MCP_CONFIG_INVALID',
      statusCode: 500,
    });
  }
}