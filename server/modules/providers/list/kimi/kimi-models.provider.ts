import { readFile } from 'node:fs/promises';

import TOML from '@iarna/toml';

import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
} from '@/shared/types.js';
import {
  buildDefaultProviderCurrentActiveModel,
  getKimiConfigPath,
  readObjectRecord,
  readOptionalString,
  readStringArray,
} from '@/shared/utils.js';

const PROVIDER = 'kimi' as const;

/** One `[models."alias"]` table as Kimi Code's config.toml writes it. */
type KimiModelConfig = {
  alias: string;
  displayName?: string;
  maxContextSize?: number;
  supportEfforts?: string[];
  defaultEffort?: string;
};

/**
 * Model catalog backed by the user's own Kimi Code `config.toml`.
 *
 * Kimi owns provider/credential configuration, so CloudCLI never ships a
 * hard-coded Kimi catalog: it lists exactly what `kimi` itself would offer.
 * Only metadata is read — `providers` tables (API keys, env) are never touched.
 */
export class KimiProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    const models = await this.readConfiguredModels();
    if (models.length === 0) {
      return { OPTIONS: [], DEFAULT: '' };
    }

    const configuredDefault = await this.readDefaultModel();
    const options: ProviderModelOption[] = models.map((model) => toModelOption(model));
    const defaultAlias = configuredDefault && options.some((option) => option.value === configuredDefault)
      ? configuredDefault
      : options[0].value;

    return { OPTIONS: options, DEFAULT: defaultAlias };
  }

  /**
   * Kimi's session state does not record which model a past session used, so
   * this falls back to the catalog default rather than inventing one.
   */
  async getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel> {
    void sessionId;
    return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
  }

  private async readDefaultModel(): Promise<string | undefined> {
    const config = await this.readConfigToml();
    return readOptionalString(config?.default_model);
  }

  private async readConfiguredModels(): Promise<KimiModelConfig[]> {
    const config = await this.readConfigToml();
    const modelsTable = readObjectRecord(config?.models);
    if (!modelsTable) {
      return [];
    }

    const models: KimiModelConfig[] = [];
    for (const [alias, rawModel] of Object.entries(modelsTable)) {
      const record = readObjectRecord(rawModel);
      if (!record) {
        continue;
      }

      const maxContextSize = typeof record.max_context_size === 'number'
        ? record.max_context_size
        : undefined;
      models.push({
        alias,
        displayName: readOptionalString(record.display_name),
        maxContextSize,
        supportEfforts: readStringArray(record.support_efforts),
        defaultEffort: readOptionalString(record.default_effort),
      });
    }

    return models.sort((left, right) => left.alias.localeCompare(right.alias));
  }

  /**
   * Parses config.toml, tolerating a missing or malformed file.
   *
   * A user who never ran Kimi, or a half-written config during an upgrade,
   * gets an empty catalog instead of a 500 on every model-list request.
   */
  private async readConfigToml(): Promise<Record<string, unknown> | null> {
    try {
      const content = await readFile(getKimiConfigPath(), 'utf8');
      return readObjectRecord(TOML.parse(content));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        console.warn('[Kimi] Unable to read config.toml for the model catalog:', error);
      }
      return null;
    }
  }
}

function toModelOption(model: KimiModelConfig): ProviderModelOption {
  const effortValues = (model.supportEfforts ?? [])
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => ({ value }));
  const effort = effortValues.length > 0
    ? {
      ...(model.defaultEffort && effortValues.some((value) => value.value === model.defaultEffort)
        ? { default: model.defaultEffort }
        : {}),
      values: effortValues,
    }
    : undefined;

  return {
    value: model.alias,
    label: model.displayName ?? model.alias,
    ...(model.maxContextSize
      ? { description: `Context window: ${model.maxContextSize.toLocaleString('en-US')} tokens` }
      : {}),
    ...(effort ? { effort } : {}),
  };
}