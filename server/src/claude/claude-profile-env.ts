import path from 'node:path';
import type { ClaudeProfile } from './claude-types.js';

export function claudeProfileEnv(profile: ClaudeProfile, secrets: Record<string, string> = {}, baseEnv: NodeJS.ProcessEnv = process.env) {
  const env: NodeJS.ProcessEnv = { ...baseEnv, ...secrets };
  env.HOME = profile.profileDir;
  env.CLAUDE_CONFIG_DIR = profile.configDir;
  env.XDG_CONFIG_HOME = path.join(profile.profileDir, '.config');
  env.XDG_CACHE_HOME = path.join(profile.profileDir, '.cache');
  const managedBin = path.join(process.env.DATA_DIR || process.env.RUNTIME_DATA_DIR || '/var/lib/agentdeck', 'provider-tools', 'bin');
  env.PATH = [managedBin, baseEnv.PATH || process.env.PATH || ''].filter(Boolean).join(path.delimiter);
  return env;
}

export function claudeSafeEnvSummary(profile: ClaudeProfile) {
  return {
    HOME: profile.profileDir,
    CLAUDE_CONFIG_DIR: profile.configDir,
    XDG_CONFIG_HOME: path.join(profile.profileDir, '.config'),
    profileId: profile.id,
  };
}
