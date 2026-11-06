import type {
  IProviderAuth,
  IProviderMcp,
  IProviderModels,
  IProviderRuntime,
  IProviderSessionSynchronizer,
  IProviderSessions,
  IProviderSkills,
} from '@/shared/interfaces.js';
import { AbstractProvider } from '@/modules/providers/shared/base/abstract.provider.js';
import { KimiProviderAuth } from '@/modules/providers/list/kimi/kimi-auth.provider.js';
import { KimiMcpProvider } from '@/modules/providers/list/kimi/kimi-mcp.provider.js';
import { KimiProviderModels } from '@/modules/providers/list/kimi/kimi-models.provider.js';
import { kimiRuntime } from '@/modules/providers/list/kimi/kimi-runtime.provider.js';
import { KimiSessionSynchronizer } from '@/modules/providers/list/kimi/kimi-session-synchronizer.provider.js';
import { KimiSessionsProvider } from '@/modules/providers/list/kimi/kimi-sessions.provider.js';
import { KimiSkillsProvider } from '@/modules/providers/list/kimi/kimi-skills.provider.js';

/**
 * Kimi Code provider: ACP chat runtime plus the MCP, skills, session, and
 * synchronization facets CloudCLI renders for every CLI-backed provider.
 *
 * Forking, message editing, and background tasks are intentionally absent from
 * the first version; their interfaces stay unimplemented so the UI hides them.
 */
export class KimiProvider extends AbstractProvider {
  readonly runtime: IProviderRuntime = kimiRuntime;
  readonly models: IProviderModels = new KimiProviderModels();
  readonly mcp: IProviderMcp = new KimiMcpProvider();
  readonly auth: IProviderAuth = new KimiProviderAuth();
  readonly skills: IProviderSkills = new KimiSkillsProvider();
  readonly sessions: IProviderSessions = new KimiSessionsProvider();
  readonly sessionSynchronizer: IProviderSessionSynchronizer = new KimiSessionSynchronizer();

  constructor() {
    super('kimi');
  }
}