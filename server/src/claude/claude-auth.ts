import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import type { AgentStatus } from '../providers.js';
import { PROVIDER_DEFINITIONS } from '../provider-registry.js';
import type { ClaudeProfile } from './claude-types.js';
import { redactClaudeText } from './claude-redaction.js';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

export async function claudeCliStatus(): Promise<AgentStatus> {
  const command = process.env.CLAUDE_BIN || 'claude';
  const found = await commandPath(command);
  if (!found) {
    const sdkVersion = claudeSdkVersion();
    if (sdkVersion) {
      return {
        id:'claude',
        displayName:PROVIDER_DEFINITIONS.claude.displayName,
        ok:true,
        installed:true,
        version:`sdk ${sdkVersion}`,
        command:null,
        error:null,
      };
    }
    return {
      id:'claude',
      displayName:PROVIDER_DEFINITIONS.claude.displayName,
      ok:false,
      installed:false,
      version:null,
      command,
      error:'Claude Code CLI/SDK binary is not available',
      installHint:'安装 @anthropic-ai/claude-agent-sdk，或设置 CLAUDE_BIN 为受信任 claude 可执行文件。',
    };
  }
  const version = await tryExec(found, ['--version']);
  return {
    id:'claude',
    displayName:PROVIDER_DEFINITIONS.claude.displayName,
    ok:!!version,
    installed:true,
    version,
    command:found,
    error:version ? null : 'Claude CLI 已发现，但 --version 未返回可用版本',
  };
}

export function claudeAuthState(profile: ClaudeProfile | null, cli: AgentStatus) {
  if (!cli.installed) return { auth:'unauthenticated' as const, status:'not_installed' as const, canCreateSession:false, message:cli.error || 'Claude Code 未安装' };
  if (!cli.ok) return { auth:'error' as const, status:'runtime_unavailable' as const, canCreateSession:false, message:cli.error || 'Claude runtime unavailable' };
  if (!profile) return { auth:'unauthenticated' as const, status:'not_configured' as const, canCreateSession:false, message:'尚未配置 Claude Code profile' };
  if (profile.status === 'invalid_credentials') return { auth:'error' as const, status:'invalid_credentials' as const, canCreateSession:false, message:'Claude 凭据无效或已过期' };
  return { auth:'authenticated' as const, status:'authenticated' as const, canCreateSession:true, message:null };
}

async function commandPath(name: string) {
  if (name.includes('/')) return existsSync(name) ? name : null;
  try {
    const { stdout } = await execFileAsync('sh', ['-lc', `command -v '${name.replaceAll("'", "'\\''")}'`], { timeout:5000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function claudeSdkVersion() {
  try {
    const pkg = require('@anthropic-ai/claude-agent-sdk/package.json') as { version?: string };
    return pkg.version || null;
  } catch {
    try {
      require.resolve('@anthropic-ai/claude-agent-sdk');
      return 'available';
    } catch {
      return null;
    }
  }
}

async function tryExec(file: string, args: string[]) {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, { timeout:5000, maxBuffer:1024 * 1024 });
    return redactClaudeText(stdout || stderr).trim();
  } catch {
    return '';
  }
}
