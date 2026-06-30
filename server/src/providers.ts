import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';

const execFileAsync = promisify(execFile);

export type AgentProviderId = 'codex' | 'antigravity';

export type AgentModel = {
  id: string;
  displayName: string;
  description: string;
  available: boolean;
  unavailableReason?: string;
  reasoningLevels?: string[];
};

export type AgentStatus = {
  id: AgentProviderId;
  displayName: string;
  ok: boolean;
  installed: boolean;
  version: string | null;
  error: string | null;
  command?: string | null;
  installHint?: string;
};

export interface AgentProvider {
  id: AgentProviderId;
  displayName: string;
  getVersion(): Promise<string | null>;
  listModels(includeHidden?: boolean, env?: NodeJS.ProcessEnv): Promise<{ models: AgentModel[]; current: string; error: string | null }>;
  status(): Promise<AgentStatus>;
}

export class AntigravityProvider implements AgentProvider {
  id: AgentProviderId = 'antigravity';
  displayName = 'Antigravity';
  private candidates = ['/home/ubuntu/.local/bin/agy', 'agy', 'antigravity', 'google-antigravity', 'gemini'];

  async getVersion() {
    const found = await this.detectCommand();
    if (!found) return null;
    const version = await tryExec(found, ['--version']);
    return version || null;
  }

  async listModels(_includeHidden?: boolean, env?: NodeJS.ProcessEnv) {
    const found = await this.detectCommand();
    const fallback = antigravityFallbackModels();
    if (!found) {
      return {
        models: [],
        current: '',
        error: 'Antigravity CLI 未安装，无法读取 Gemini/Antigravity 模型列表',
      };
    }
    const listed = await tryExecDetailed(found, ['models'], env, 2500);
    if (!listed.ok) {
      if (fallback.length) {
        return {
          models: fallback,
          current: fallback[0]?.id || '',
          error: null,
        };
      }
      const message = listed.output || 'agy models failed';
      const lower = message.toLowerCase();
      const loginError = lower.includes('sign in') || lower.includes('login') || message.includes('登录');
      return {
        models: [],
        current: '',
        error: loginError ? '请先登录 Antigravity，再读取模型列表' : message,
      };
    }
    const models = parseModels(listed.output);
    return {
      models: models.length ? models : fallback,
      current: (models[0] || fallback[0])?.id || '',
      error: models.length ? null : 'agy models 没有返回可解析的模型',
    };
  }

  async status(): Promise<AgentStatus> {
    const found = await this.detectCommand();
    if (!found) {
      return {
        id: this.id,
        displayName: this.displayName,
        ok: false,
        installed: false,
        version: null,
        command: null,
        error: 'Antigravity CLI 未安装',
        installHint: '需要先安装 Google 官方 Antigravity/Gemini Coding Agent CLI，并确认登录、模型、恢复会话等命令后才能启用。',
      };
    }
    const version = await this.getVersion();
    return {
      id: this.id,
      displayName: this.displayName,
      ok: !!version,
      installed: true,
      version,
      command: found,
      error: version ? null : '已发现 CLI，但 --version 未返回可用版本',
    };
  }

  private async detectCommand() {
    for (const name of this.candidates) {
      const found = await commandPath(name);
      if (found) return found;
    }
    return null;
  }
}

function antigravityFallbackModels(): AgentModel[] {
  return [
    'Gemini 3.5 Flash (Medium)',
    'Gemini 3.5 Flash (High)',
    'Gemini 3.5 Flash (Low)',
    'Gemini 3.1 Pro (Low)',
    'Gemini 3.1 Pro (High)',
    'Claude Sonnet 4.6 (Thinking)',
    'Claude Opus 4.6 (Thinking)',
    'GPT-OSS 120B (Medium)',
  ].map(id => ({ id, displayName:id, description:'Antigravity CLI model', available:true, reasoningLevels:[] }));
}

async function commandPath(name: string) {
  if (name.includes('/') && existsSync(name)) return name;
  try {
    const { stdout } = await execFileAsync('sh', ['-lc', `command -v ${shellQuote(name)}`], { timeout: 5000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function tryExec(file: string, args: string[]) {
  const result = await tryExecDetailed(file, args);
  return result.ok ? result.output : '';
}

async function tryExecDetailed(file: string, args: string[], env?: NodeJS.ProcessEnv, timeout = 5000) {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, { env, timeout, maxBuffer: 1024 * 1024 });
    return { ok: true, output: (stdout || stderr).trim() };
  } catch (e: any) {
    return { ok: false, output: String(e?.stdout || e?.stderr || e?.message || e).trim() };
  }
}

function parseModels(output: string): AgentModel[] {
  const models: AgentModel[] = [];
  for (const line of output
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !/^available models/i.test(line))
    .map(line => line.replace(/^[-*]\s*/, ''))) {
    const id = line.trim();
    if (!id || id.length > 160) continue;
    models.push({ id, displayName: id, description: '', available: true, reasoningLevels: [] });
  }
  return models;
}
