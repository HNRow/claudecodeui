import { readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import TOML from '@iarna/toml';

import { SkillsProvider } from '@/modules/providers/shared/skills/skills.provider.js';
import type { ProviderSkillSource, ProviderSkillListOptions, ProviderSkill } from '@/shared/types.js';
import {
  addUniqueProviderSkillSource,
  getKimiCodeHome,
  getKimiConfigPath,
  readObjectRecord,
  readStringArray,
} from '@/shared/utils.js';

const PROVIDER = 'kimi' as const;
const COMMAND_PREFIX = '/skill:';

/**
 * Skills discovery for Kimi Code's native locations.
 *
 * Kimi loads user skills from `$KIMI_CODE_HOME/skills` and `~/.agents/skills`,
 * project skills from the nearest git root's `.kimi-code/skills` and
 * `.agents/skills`, plus any `extra_skill_dirs` from config.toml. Both the
 * directory (`<name>/SKILL.md`) and flat (`<name>.md`) forms are indexed, and
 * the invocation is `/skill:<name>`. Kimi still loads the skill content itself;
 * CloudCLI only lists what it can discover.
 */
export class KimiSkillsProvider extends SkillsProvider {
  constructor() {
    super(PROVIDER);
  }

  /**
   * Lists skills with Kimi's precedence: project beats user beats extra, and
   * the first source that declares a name owns it.
   */
  async listSkills(options?: ProviderSkillListOptions): Promise<ProviderSkill[]> {
    const skills = await super.listSkills(options);
    const seenNames = new Set<string>();
    return skills.filter((skill) => {
      if (seenNames.has(skill.name)) {
        return false;
      }
      seenNames.add(skill.name);
      return true;
    });
  }

  protected async getSkillSources(workspacePath: string): Promise<ProviderSkillSource[]> {
    const sources: ProviderSkillSource[] = [];
    const seenRoots = new Set<string>();
    const projectRoot = await findNearestProjectRoot(workspacePath);

    for (const rootDir of [path.join(projectRoot, '.kimi-code', 'skills'), path.join(projectRoot, '.agents', 'skills')]) {
      addUniqueProviderSkillSource(sources, seenRoots, this.toSource('project', rootDir));
    }

    for (const rootDir of [path.join(getKimiCodeHome(), 'skills'), path.join(os.homedir(), '.agents', 'skills')]) {
      addUniqueProviderSkillSource(sources, seenRoots, this.toSource('user', rootDir));
    }

    for (const extraDir of await readExtraSkillDirs()) {
      addUniqueProviderSkillSource(sources, seenRoots, this.toSource('user', extraDir));
    }

    return sources;
  }

  /** New skills are installed into Kimi's managed user skills folder. */
  protected async getGlobalSkillSource(): Promise<ProviderSkillSource | null> {
    return this.toSource('user', path.join(getKimiCodeHome(), 'skills'));
  }

  private toSource(scope: 'project' | 'user', rootDir: string): ProviderSkillSource {
    return {
      scope,
      rootDir,
      includeFlatMarkdown: true,
      commandForSkill: (skillName) => `${COMMAND_PREFIX}${skillName}`,
    };
  }
}

/**
 * Walks up from the workspace to the nearest directory holding `.git`.
 *
 * Kimi scopes project skills by the nearest repository root, not by the
 * backend's cwd and not by the outermost ancestor, so the walk stops at the
 * first hit and falls back to the workspace itself.
 */
async function findNearestProjectRoot(workspacePath: string): Promise<string> {
  let currentPath = path.resolve(workspacePath);

  while (true) {
    try {
      await stat(path.join(currentPath, '.git'));
      return currentPath;
    } catch {
      // Keep walking upward until the filesystem root.
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      return path.resolve(workspacePath);
    }
    currentPath = parentPath;
  }
}

/** Reads `extra_skill_dirs` from config.toml; missing or malformed config yields none. */
async function readExtraSkillDirs(): Promise<string[]> {
  try {
    const content = await readFile(getKimiConfigPath(), 'utf8');
    const config = readObjectRecord(TOML.parse(content));
    if (!config) {
      return [];
    }

    const skillsSection = readObjectRecord(config.skills);
    const configured = readStringArray(config.extra_skill_dirs)
      ?? readStringArray(skillsSection?.extra_skill_dirs)
      ?? [];

    return configured
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => (entry === '~'
        ? os.homedir()
        : entry.startsWith('~/')
          ? path.join(os.homedir(), entry.slice(2))
          : path.resolve(entry)));
  } catch {
    return [];
  }
}