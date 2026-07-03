import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import type { AgentStatus } from '../providers.js';
import { PROVIDER_DEFINITIONS } from '../provider-registry.js';
import type { ClaudeProfile } from './claude-types.js';
import { redactClaudeText } from './claude-redaction.js';
import { claudeProfileEnv } from './claude-profile-env.js';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

export async function claudeCliStatus(): Promise<AgentStatus> {
  const command = process.env.CLAUDE_BIN || 'claude';
  const found = await detectClaudeCommand();
  if (!found) {
    const sdkVersion = claudeSdkVersion();
    return {
      id:'claude',
      displayName:PROVIDER_DEFINITIONS.claude.displayName,
      ok:false,
      installed:false,
      version:sdkVersion ? `sdk ${sdkVersion}` : null,
      command,
      error:sdkVersion ? 'Claude Agent SDK 已安装，但 Claude Code CLI binary 不可用' : 'Claude Code CLI/SDK binary is not available',
      installHint:'安装 Claude Code CLI，或设置 CLAUDE_BIN 为受信任 claude 可执行文件。',
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

async function detectClaudeCommand() {
  for (const candidate of [process.env.CLAUDE_BIN, `${process.env.DATA_DIR || '/var/lib/agentdeck'}/provider-tools/bin/claude`, 'claude'].filter(Boolean) as string[]) {
    const found = await commandPath(candidate);
    if (found) return found;
  }
  return null;
}

export async function claudeAuthStatus(profile: ClaudeProfile): Promise<{ ok:boolean; output:string; error:string | null }> {
  const cli = await claudeCliStatus();
  if (!cli.command || !cli.installed) return { ok:false, output:'', error:cli.error || 'Claude Code CLI 未安装' };
  if (!cli.ok) return { ok:false, output:'', error:cli.error || 'Claude Code CLI 不可用' };
  const result = await tryExecDetailed(cli.command, ['auth', 'status'], claudeProfileEnv(profile));
  return result.ok
    ? { ok:true, output:result.output, error:null }
    : { ok:false, output:result.output, error:result.output || 'Claude auth status failed' };
}

export async function claudeAuthLogout(profile: ClaudeProfile): Promise<{ ok:boolean; output:string; error:string | null }> {
  const cli = await claudeCliStatus();
  if (!cli.command || !cli.installed) return { ok:false, output:'', error:cli.error || 'Claude Code CLI 未安装' };
  const result = await tryExecDetailed(cli.command, ['auth', 'logout'], claudeProfileEnv(profile), 30_000);
  return result.ok
    ? { ok:true, output:result.output, error:null }
    : { ok:false, output:result.output, error:result.output || 'Claude auth logout failed' };
}

export function claudeAuthState(profile: ClaudeProfile | null, cli: AgentStatus) {
  if (!cli.installed) return { auth:'unauthenticated' as const, status:'not_installed' as const, canCreateSession:false, message:cli.error || 'Claude Code 未安装' };
  if (!cli.ok) return { auth:'error' as const, status:'runtime_unavailable' as const, canCreateSession:false, message:cli.error || 'Claude runtime unavailable' };
  if (!profile) return { auth:'unauthenticated' as const, status:'not_configured' as const, canCreateSession:false, message:'尚未配置 Claude Code profile' };
  if (profile.status === 'invalid_credentials') return { auth:'error' as const, status:'invalid_credentials' as const, canCreateSession:false, message:'Claude 凭据无效或已过期' };
  return { auth:'authenticated' as const, status:'authenticated' as const, canCreateSession:true, message:null };
}

export async function commandPath(name: string) {
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
  const result = await tryExecDetailed(file, args);
  return result.ok ? result.output : '';
}

async function tryExecDetailed(file: string, args: string[], env?: NodeJS.ProcessEnv, timeout = 5000) {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, { env, timeout, maxBuffer:1024 * 1024 });
    return { ok:true, output:redactClaudeText(stdout || stderr).trim() };
  } catch (e:any) {
    return { ok:false, output:redactClaudeText(String(e?.stdout || e?.stderr || e?.message || e)).trim() };
  }
}
