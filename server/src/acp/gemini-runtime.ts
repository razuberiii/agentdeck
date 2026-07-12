import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { mkdir, readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { existsSync, realpathSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ClientConnection,
  type ClientContext,
  type ContentBlock,
  type InitializeResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type SessionUpdate,
} from '@agentclientprotocol/sdk';
import { Db } from '../db.js';
import { readSessionTextFile, writeSessionTextFile, type FilePermissionMode } from '../secure-workspace-fs.js';

export type GeminiRuntimeOptions = {
  db: Db;
  dataDir: string;
  defaultCwd: string;
  profileId: string;
  profileDir: string;
  profileEnv?: Record<string, string>;
  appendEvent(sessionId: string, eventType: string, payload: any): Promise<any>;
  updateSession(sessionId: string, values: Record<string, string | number | null>): Promise<void>;
  logger?: {
    info(obj: any, msg?: string): void;
    warn(obj: any, msg?: string): void;
    error(obj: any, msg?: string): void;
  };
};

type GeminiSessionState = {
  localSessionId: string;
  providerSessionId: string;
  cwd: string;
  configOptions: any[];
  model: string | null;
  activePrompt: Promise<any> | null;
  promptController: AbortController | null;
  permissionMode:FilePermissionMode;
};

export class GeminiModelSwitchUnsupportedError extends Error {
  code = 'gemini_model_switch_unsupported';
  statusCode = 409;

  constructor(message = '当前 Gemini CLI ACP 未公开可切换模型，继续使用 CLI 默认配置。') {
    super(message);
  }
}
function normalizeFileMode(mode?:string):FilePermissionMode{return mode==='plan'?'plan':mode==='read-only'?'read-only':mode==='workspace-write'?'workspace-write':mode==='full-access'?'full-access':'yolo';}

type PendingPermission = {
  requestId: string;
  localSessionId: string;
  providerSessionId: string;
  request: RequestPermissionRequest;
  createdAt: number;
  resolve: (response: RequestPermissionResponse) => void;
};

export class GeminiAcpRuntime {
  private child: ChildProcessWithoutNullStreams | null = null;
  private connection: ClientConnection | null = null;
  private agent: ClientContext | null = null;
  private initializeResponse: InitializeResponse | null = null;
  private connectPromise: Promise<void> | null = null;
  private sessions = new Map<string, GeminiSessionState>();
  private providerToLocal = new Map<string, string>();
  private permissions = new Map<string, PendingPermission>();
  private lastError: string | null = null;
  private restarting = false;
  private authState: 'unknown' | 'authenticated' | 'needs_login' | 'failed' = 'unknown';
  private launchModel: string | null = null;

  constructor(private options: GeminiRuntimeOptions) {}

  activePromptCount() { return [...this.sessions.values()].filter(state => !!state.activePrompt).length; }

  status() {
    return {
      installed: existsSync(this.geminiBin()),
      command: this.geminiBin(),
      acpArgs: this.geminiArgs(),
      connected: !!this.connection && !this.connection.signal.aborted,
      initialized: !!this.initializeResponse,
      authenticated: this.authState === 'authenticated' || (this.authState === 'unknown' && this.hasLocalCredentials()),
      authState: this.authState,
      authMethods: this.initializeResponse?.authMethods || [],
      capabilities: this.initializeResponse?.agentCapabilities || null,
      agentInfo: this.initializeResponse?.agentInfo || null,
      profileId: this.options.profileId,
      profileDir: this.options.profileDir,
      childPid: this.child?.pid || null,
      lastError: this.lastError,
    };
  }

  async ensureInitialized() {
    if (this.agent && this.initializeResponse && !this.connection?.signal.aborted) return;
    if (!this.connectPromise) this.connectPromise = this.connect().finally(() => { this.connectPromise = null; });
    await this.connectPromise;
  }

  async createSession(params: { localSessionId: string; cwd: string; mode?: string; model?: string | null }) {
    if (!this.initializeResponse && params.model) this.launchModel = params.model;
    await this.ensureInitialized();
    const existing = this.sessions.get(params.localSessionId);
    if (existing) return existing;
    let response: any;
    try {
      response = await this.agent!.request(methods.agent.session.new, {
        cwd: params.cwd,
        mcpServers: [],
        _meta: { agentdeckSessionId: params.localSessionId, profileId: this.options.profileId },
      });
      this.authState = 'authenticated';
    } catch (e) {
      this.noteAuthError(e);
      throw e;
    }
    const state: GeminiSessionState = {
      localSessionId: params.localSessionId,
      providerSessionId: response.sessionId,
      cwd: params.cwd,
      configOptions: Array.isArray(response.configOptions) ? response.configOptions : [],
      model: params.model || currentGeminiModelFromOptions(response.configOptions) || null,
      activePrompt: null,
      promptController: null,
      permissionMode:normalizeFileMode(params.mode),
    };
    this.sessions.set(params.localSessionId, state);
    this.providerToLocal.set(response.sessionId, params.localSessionId);
    await this.options.updateSession(params.localSessionId, {
      provider_session_id: response.sessionId,
      provider_capabilities: JSON.stringify(this.initializeResponse?.agentCapabilities || {}),
      provider_metadata: JSON.stringify({ agentInfo: this.initializeResponse?.agentInfo || null, modes: response.modes || null, configOptions: response.configOptions || null, currentModel: state.model || null }),
      status: 'idle',
      updated_at: Date.now(),
    });
    await this.options.appendEvent(params.localSessionId, 'gemini/session_new', {
      providerSessionId: response.sessionId,
      modes: response.modes || null,
      configOptions: response.configOptions || null,
      capabilities: this.initializeResponse?.agentCapabilities || null,
    });
    return state;
  }

  async setSessionModel(localSessionId: string, model: string | null) {
    await this.ensureInitialized();
    const state = this.sessions.get(localSessionId);
    if (!state) throw new GeminiModelSwitchUnsupportedError();
    const modelConfig = findGeminiModelConfig(state.configOptions);
    if (!modelConfig?.id) throw new GeminiModelSwitchUnsupportedError();
    if (!model) throw new GeminiModelSwitchUnsupportedError('当前 Gemini CLI ACP 未公开可切换为自动模型，继续使用当前配置。');
    const allowed = geminiModelValues(modelConfig);
    if (allowed.length && !allowed.includes(model)) {
      const err:any = new Error(`Gemini 模型不在当前 ACP 会话返回的可选列表中：${model}`);
      err.code = 'gemini_model_not_available';
      err.statusCode = 400;
      throw err;
    }
    const response:any = await this.agent!.request(methods.agent.session.setConfigOption, {
      sessionId: state.providerSessionId,
      configId: modelConfig.id,
      value: model,
    });
    if (Array.isArray(response?.configOptions)) state.configOptions = response.configOptions;
    state.model = currentGeminiModelFromOptions(state.configOptions) || model;
    await this.options.updateSession(localSessionId, {
      model: state.model,
      model_id: state.model,
      provider_metadata: JSON.stringify({
        agentInfo: this.initializeResponse?.agentInfo || null,
        configOptions: state.configOptions,
        currentModel: state.model,
        modelSwitch: { supported:true, configId:modelConfig.id, updatedAt:Date.now() },
      }),
      updated_at: Date.now(),
    });
    await this.options.appendEvent(localSessionId, 'gemini/model_changed', {
      provider:'gemini',
      providerSessionId:state.providerSessionId,
      model:state.model,
      configId:modelConfig.id,
    });
    return { supported:true, model:state.model, configOptions:state.configOptions };
  }

  async authenticate(methodId: string) {
    await this.ensureInitialized();
    const response = await this.agent!.request(methods.agent.authenticate, { methodId });
    return response || {};
  }

  async logout() {
    await this.ensureInitialized();
    const response = await this.agent!.request(methods.agent.logout, {});
    await this.restart();
    return response || {};
  }

  async dispose(reason = 'Gemini ACP disposed') {
    const child = this.child;
    const exited = child && !child.killed ? new Promise<void>(resolve => {
      const done = () => resolve();
      child.once('exit', done);
      setTimeout(done, 1500).unref();
    }) : Promise.resolve();
    for (const pending of this.permissions.values()) pending.resolve({ outcome:{ outcome:'cancelled' } });
    this.permissions.clear();
    for (const state of this.sessions.values()) {
      state.promptController?.abort();
      await this.options.updateSession(state.localSessionId, { active_turn_id:null, updated_at:Date.now() }).catch(()=>{});
      await this.options.appendEvent(state.localSessionId, 'runtime/disconnect', { provider:'gemini', reason }).catch(()=>{});
    }
    this.sessions.clear();
    this.providerToLocal.clear();
    this.connection?.close(new Error(reason));
    this.connection = null;
    this.agent = null;
    this.initializeResponse = null;
    this.connectPromise = null;
    if (this.child && !this.child.killed) this.child.kill();
    this.child = null;
    this.lastError = reason;
    await exited;
  }

  async restart() {
    this.restarting = true;
    try {
      for (const pending of this.permissions.values()) pending.resolve({ outcome:{ outcome:'cancelled' } });
      this.permissions.clear();
      this.sessions.clear();
      this.providerToLocal.clear();
      this.connection?.close(new Error('Gemini ACP restarting'));
      this.connection = null;
      this.agent = null;
      this.initializeResponse = null;
      if (this.child && !this.child.killed) this.child.kill();
      this.child = null;
      await this.ensureInitialized();
    } finally {
      this.restarting = false;
    }
  }

  async prompt(localSessionId: string, prompt: ContentBlock[]) {
    const state = this.sessions.get(localSessionId);
    if (!state) throw new Error('Gemini session is not initialized');
    if (state.activePrompt) throw new Error('Gemini turn already running');
    const controller = new AbortController();
    state.promptController = controller;
    const task = Promise.resolve().then(async () => {
      await this.options.updateSession(localSessionId, { status: 'running', updated_at: Date.now() });
      await this.options.appendEvent(localSessionId, 'turn/started', { provider:'gemini', providerSessionId:state.providerSessionId });
      const started = Date.now();
      const response = await this.agent!.request(methods.agent.session.prompt, {
        sessionId: state.providerSessionId,
        prompt,
      }, { cancellationSignal: controller.signal });
      await this.options.appendEvent(localSessionId, 'turn/completed', { provider:'gemini', providerSessionId:state.providerSessionId, response, elapsedMs:Date.now() - started });
      await this.options.updateSession(localSessionId, { status: 'idle', active_turn_id: null, updated_at: Date.now() });
      return response;
    }).catch(async e => {
      const message = e?.message || String(e);
      this.noteAuthError(e);
      await Promise.allSettled([
        this.options.appendEvent(localSessionId, 'turn/failed', { provider:'gemini', providerSessionId:state.providerSessionId, error:{ message } }),
        this.options.updateSession(localSessionId, { status: 'interrupted', active_turn_id: null, interruption_reason: 'gemini_prompt_failed', updated_at: Date.now() }),
      ]);
      throw e;
    }).finally(() => {
      state.activePrompt = null;
      state.promptController = null;
    });
    state.activePrompt = task;
    return task;
  }

  async cancel(localSessionId: string) {
    const state = this.sessions.get(localSessionId);
    if (!state) return { ok:true, missing:true };
    await this.agent?.notify(methods.agent.session.cancel, { sessionId: state.providerSessionId });
    state.promptController?.abort();
    for (const [id, pending] of this.permissions) {
      if (pending.localSessionId === localSessionId) {
        pending.resolve({ outcome:{ outcome:'cancelled' } });
        this.permissions.delete(id);
      }
    }
    await this.options.appendEvent(localSessionId, 'turn/interrupted', { provider:'gemini', providerSessionId:state.providerSessionId, reason:'manual_stop' });
    await this.options.updateSession(localSessionId, { status:'interrupted', active_turn_id:null, interruption_reason:'manual_stop', updated_at:Date.now() });
    return { ok:true };
  }

  answerPermission(requestId: string, optionId: string | null) {
    const pending = this.permissions.get(requestId);
    if (!pending) return false;
    this.permissions.delete(requestId);
    pending.resolve(optionId ? { outcome:{ outcome:'selected', optionId } } : { outcome:{ outcome:'cancelled' } });
    return true;
  }

  async recoverSession(localSessionId: string, providerSessionId: string | null, cwd: string, mode?:string) {
    await this.ensureInitialized();
    if (providerSessionId && this.initializeResponse?.agentCapabilities?.loadSession) {
      try {
        const response = await this.agent!.request(methods.agent.session.load, { sessionId:providerSessionId, cwd, mcpServers:[] } as any);
        if (response !== undefined) {
          const configOptions = Array.isArray((response as any)?.configOptions) ? (response as any).configOptions : [];
          const state = { localSessionId, providerSessionId, cwd, configOptions, model:currentGeminiModelFromOptions(configOptions), activePrompt:null, promptController:null,permissionMode:normalizeFileMode(mode) };
          this.sessions.set(localSessionId, state);
          this.providerToLocal.set(providerSessionId, localSessionId);
          await this.options.appendEvent(localSessionId, 'runtime/recovering', { provider:'gemini', loaded:true, providerSessionId });
          return state;
        }
      } catch (e:any) {
        if (isGeminiAuthenticationError(e)) {
          this.authState = 'needs_login';
          throw e;
        }
        await this.options.appendEvent(localSessionId, 'runtime/recovering', { provider:'gemini', loaded:false, providerSessionId, error:e?.message || String(e) });
      }
    }
    const state = await this.createSession({ localSessionId, cwd });
    await this.options.appendEvent(localSessionId, 'thread_recovered_with_new_upstream', {
      provider:'gemini',
      oldProviderSessionId: providerSessionId,
      newProviderSessionId: state.providerSessionId,
      warning: 'Gemini ACP session was recreated; in-flight work could not be resumed.',
    });
    return state;
  }

  private async connect() {
    await mkdir(this.profileDir(), { recursive:true, mode:0o700 });
    await chmod(this.profileDir(), 0o700).catch(()=>{});
    const configDir = path.join(this.profileDir(), '.gemini');
    await mkdir(configDir, { recursive:true, mode:0o700 });
    await chmod(configDir, 0o700).catch(()=>{});
    const envSummary = {
      HOME:this.profileDir(),
      GEMINI_CONFIG_DIR:configDir,
      XDG_CONFIG_HOME:path.join(this.profileDir(), '.config'),
      workingDirectory:this.options.defaultCwd,
      profileId:this.options.profileId,
    };
    const child = spawn(this.geminiBin(), this.geminiArgs(), {
      cwd: this.options.defaultCwd,
      env: {
        ...process.env,
        HOME:this.profileDir(),
        GEMINI_CONFIG_DIR:configDir,
        XDG_CONFIG_HOME:path.join(this.profileDir(), '.config'),
        XDG_CACHE_HOME:path.join(this.profileDir(), '.cache'),
        ...(this.options.profileEnv || {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      const text = String(chunk).trim();
      if (text) this.options.logger?.warn({ provider:'gemini', profileId:this.options.profileId, pid:child.pid, stderr:redactSecretText(text).slice(0, 1000) }, 'gemini acp stderr');
    });
    child.on('exit', (code, signal) => {
      this.lastError = `Gemini ACP exited code=${code} signal=${signal}`;
      this.connection?.close(new Error(this.lastError));
      this.connection = null;
      this.agent = null;
      this.initializeResponse = null;
      for (const pending of this.permissions.values()) pending.resolve({ outcome:{ outcome:'cancelled' } });
      this.permissions.clear();
      for (const state of this.sessions.values()) {
        this.options.updateSession(state.localSessionId, { status:'interrupted', active_turn_id:null, interruption_reason:'gemini_process_exit', updated_at:Date.now() }).catch(()=>{});
        this.options.appendEvent(state.localSessionId, 'runtime/disconnect', { provider:'gemini', code, signal }).catch(()=>{});
      }
      this.sessions.clear();
      this.providerToLocal.clear();
      if (this.restarting) this.lastError = null;
    });

    const app = client({ name:'AgentDeck Runtime' })
      .onRequest(methods.client.session.requestPermission, async ({ params }) => this.handlePermission(params))
      .onRequest(methods.client.fs.readTextFile, async ({ params }) => this.readTextFile(params.sessionId, params.path, params.line || 1, params.limit || null))
      .onRequest(methods.client.fs.writeTextFile, async ({ params }) => this.writeTextFile(params.sessionId, params.path, params.content))
      .onRequest(methods.client.terminal.create, async () => { throw new Error('AgentDeck Gemini terminal proxy is not enabled'); })
      .onNotification(methods.client.session.update, async ({ params }) => this.handleUpdate(params));
    const stream = ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>);
    const connection = app.connect(stream);
    this.connection = connection;
    this.agent = connection.agent;
    this.initializeResponse = await this.agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name:'agentdeck-runtime', title:'AgentDeck Runtime', version:'1.0.0' },
      clientCapabilities: {
        fs: { readTextFile:true, writeTextFile:true },
        terminal: false,
        session: { planUpdates:true } as any,
      },
    });
    const initialized = this.initializeResponse!;
    this.lastError = null;
    if (this.hasLocalCredentials()) this.authState = 'authenticated';
    this.options.logger?.info({ provider:'gemini', profileId:this.options.profileId, pid:child.pid, env:envSummary, agentInfo:initialized.agentInfo, capabilities:initialized.agentCapabilities, authMethodCount:initialized.authMethods?.length || 0 }, 'gemini acp initialized');
  }

  private async handleUpdate(notification: SessionNotification) {
    const localSessionId = this.providerToLocal.get(notification.sessionId);
    if (!localSessionId) return;
    const mapped = mapGeminiUpdate(notification.update);
    if (mapped) await this.options.appendEvent(localSessionId, mapped.eventType, { provider:'gemini', providerSessionId:notification.sessionId, ...mapped.payload, acp:{ sessionUpdate:notification.update.sessionUpdate } });
  }

  private async handlePermission(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const localSessionId = this.providerToLocal.get(request.sessionId);
    if (!localSessionId) return { outcome:{ outcome:'cancelled' } };
    const requestId = `gemini-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await this.options.appendEvent(localSessionId, 'approval/requested', { provider:'gemini', requestId, request });
    return new Promise(resolve => {
      this.permissions.set(requestId, { requestId, localSessionId, providerSessionId:request.sessionId, request, createdAt:Date.now(), resolve });
      setTimeout(() => {
        const pending = this.permissions.get(requestId);
        if (!pending) return;
        this.permissions.delete(requestId);
        pending.resolve({ outcome:{ outcome:'cancelled' } });
      }, 10 * 60_000).unref();
    });
  }

  private async readTextFile(providerSessionId: string, requestedPath: string, line: number, limit: number | null) {
    const localSessionId = this.providerToLocal.get(providerSessionId);
    if (!localSessionId) throw new Error('unknown session');
    const session=this.sessions.get(localSessionId);if(!session)throw new Error('unknown session');
    return { content:await readSessionTextFile(session.cwd,path.join(this.options.dataDir,'attachments',localSessionId),requestedPath,line,limit) };
  }

  private async writeTextFile(providerSessionId: string, requestedPath: string, content: string) {
    const localSessionId = this.providerToLocal.get(providerSessionId);
    if (!localSessionId) throw new Error('unknown session');
    const session=this.sessions.get(localSessionId);if(!session)throw new Error('unknown session');
    await writeSessionTextFile(session.cwd,requestedPath,content,session.permissionMode);
    return {};
  }

  private noteAuthError(error:any) {
    if (isGeminiAuthenticationError(error)) this.authState = 'needs_login';
  }

  private hasLocalCredentials() {
    const configDir = path.join(this.profileDir(), '.gemini');
    if (existsSync(path.join(configDir, 'oauth_creds.json'))) return true;
    const secretFile = path.join(this.profileDir(), 'agentdeck.env');
    if (!existsSync(secretFile)) return false;
    try {
      return readFileSync(secretFile, 'utf8').split(/\r?\n/).some(line => line.trimStart().startsWith('GEMINI_API_KEY=') && line.split('=').slice(1).join('=').trim().length > 0);
    } catch {
      return false;
    }
  }

  private geminiBin() {
    return process.env.GEMINI_BIN || '/usr/bin/gemini';
  }

  private geminiArgs() {
    const args = (process.env.GEMINI_ACP_ARGS || '--acp').split(/\s+/).filter(Boolean);
    if (this.launchModel && !args.includes('--model') && !args.includes('-m')) args.push('--model', this.launchModel);
    return args;
  }

  private profileDir() {
    return this.options.profileDir;
  }
}

function findGeminiModelConfig(options:any[]) {
  return (Array.isArray(options) ? options : []).find((opt:any) => {
    const text = `${opt?.category || ''} ${opt?.id || ''} ${opt?.name || ''} ${opt?.title || ''}`.toLowerCase();
    return text.includes('model');
  }) || null;
}

function geminiModelValues(option:any) {
  const values = Array.isArray(option?.values) ? option.values
    : Array.isArray(option?.options) ? option.options
    : Array.isArray(option?.items) ? option.items
    : Array.isArray(option?.choices) ? option.choices
    : [];
  return values.map((value:any) => typeof value === 'string' ? value : String(value?.id || value?.value || value?.model || value?.name || '')).filter(Boolean);
}

function currentGeminiModelFromOptions(options:any[]) {
  const config = findGeminiModelConfig(options);
  if (!config) return null;
  const direct = String(config.currentValue || config.value || '').trim();
  if (direct) return direct;
  const values = Array.isArray(config?.values) ? config.values
    : Array.isArray(config?.options) ? config.options
    : Array.isArray(config?.items) ? config.items
    : Array.isArray(config?.choices) ? config.choices
    : [];
  const selected = values.find((value:any) => value?.selected || value?.default);
  return selected ? String(selected.id || selected.value || selected.model || selected.name || '').trim() || null : null;
}

function isGeminiAuthenticationError(error:any) {
  const message = String(error?.message || error || '').toLowerCase();
  return /\b(unauthenticated|unauthorized|authentication required|not authenticated|not logged in|login required|requires login|invalid credentials|invalid_grant|api key.*invalid|permission denied)\b/i.test(message);
}

function redactSecretText(text:string) {
  return String(text || '')
    .replace(/(GEMINI_API_KEY|GOOGLE_API_KEY|API[_ -]?KEY)\s*[:=]\s*[^\s]+/ig, '$1=[redacted]')
    .replace(/(access_token|refresh_token|id_token|client_secret|authorization code)\s*[:=]\s*[^\s]+/ig, '$1=[redacted]');
}

function textFromContent(content: any): string {
  if (!content) return '';
  if (content.type === 'text') return String(content.text || '');
  if (content.type === 'resource_link') return `[${content.name || content.uri}](${content.uri})`;
  if (content.type === 'resource') return String(content.resource?.text || content.resource?.uri || '');
  return '';
}

function mapGeminiUpdate(update: SessionUpdate): { eventType: string; payload: any } | null {
  const kind = update.sessionUpdate;
  if (kind === 'agent_message_chunk') {
    return { eventType:'item/agentMessage/delta', payload:{ params:{ itemId:update.messageId || 'gemini-live-agent', delta:textFromContent(update.content) } } };
  }
  if (kind === 'agent_thought_chunk') {
    return { eventType:'item/completed', payload:{ params:{ item:{ id:update.messageId || `gemini-thought-${Date.now()}`, type:'reasoning', content:[textFromContent(update.content)], summary:[] } } } };
  }
  if (kind === 'tool_call') {
    return { eventType:'item/completed', payload:{ params:{ item:{ id:update.toolCallId, type:update.kind === 'execute' ? 'commandExecution' : 'dynamicToolCall', tool:update.title, status:update.status || 'inProgress', result:toolText(update) } } } };
  }
  if (kind === 'tool_call_update') {
    return { eventType:'item/completed', payload:{ params:{ item:{ id:update.toolCallId, type:update.kind === 'execute' ? 'commandExecution' : 'dynamicToolCall', tool:update.title || update.toolCallId, status:update.status || 'inProgress', result:toolText(update) } } } };
  }
  if (kind === 'plan') {
    return { eventType:'item/completed', payload:{ params:{ item:{ id:`gemini-plan-${Date.now()}`, type:'plan', text:update.entries.map(e => `${e.status}: ${e.content}`).join('\n') } } } };
  }
  if (kind === 'current_mode_update' || kind === 'config_option_update') {
    return { eventType:'thread/status/changed', payload:{ params:{ status:'active', gemini:update } } };
  }
  return { eventType:`gemini/${kind}`, payload:{ update } };
}

function toolText(update: any) {
  const parts = [];
  if (update.title) parts.push(String(update.title));
  if (update.rawInput) parts.push(JSON.stringify(update.rawInput));
  if (update.rawOutput) parts.push(JSON.stringify(update.rawOutput));
  if (Array.isArray(update.content)) parts.push(...update.content.map((c:any) => JSON.stringify(c)));
  return parts.join('\n');
}
