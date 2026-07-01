import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { mkdir, readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
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
  activePrompt: Promise<any> | null;
  promptController: AbortController | null;
};

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

  constructor(private options: GeminiRuntimeOptions) {}

  status() {
    return {
      installed: existsSync(this.geminiBin()),
      command: this.geminiBin(),
      acpArgs: this.geminiArgs(),
      connected: !!this.connection && !this.connection.signal.aborted,
      initialized: !!this.initializeResponse,
      authenticated: !!this.initializeResponse && !this.initializeResponse.authMethods?.length,
      authMethods: this.initializeResponse?.authMethods || [],
      capabilities: this.initializeResponse?.agentCapabilities || null,
      agentInfo: this.initializeResponse?.agentInfo || null,
      profileId: this.options.profileId,
      profileDir: this.options.profileDir,
      lastError: this.lastError,
    };
  }

  async ensureInitialized() {
    if (this.agent && this.initializeResponse && !this.connection?.signal.aborted) return;
    if (!this.connectPromise) this.connectPromise = this.connect().finally(() => { this.connectPromise = null; });
    await this.connectPromise;
  }

  async createSession(params: { localSessionId: string; cwd: string; mode?: string; model?: string | null }) {
    await this.ensureInitialized();
    this.requireAuthenticated();
    const existing = this.sessions.get(params.localSessionId);
    if (existing) return existing;
    const response = await this.agent!.request(methods.agent.session.new, {
      cwd: params.cwd,
      mcpServers: [],
      _meta: { agentdeckSessionId: params.localSessionId, profileId: this.options.profileId },
    });
    const state: GeminiSessionState = {
      localSessionId: params.localSessionId,
      providerSessionId: response.sessionId,
      cwd: params.cwd,
      activePrompt: null,
      promptController: null,
    };
    this.sessions.set(params.localSessionId, state);
    this.providerToLocal.set(response.sessionId, params.localSessionId);
    await this.options.updateSession(params.localSessionId, {
      provider_session_id: response.sessionId,
      provider_capabilities: JSON.stringify(this.initializeResponse?.agentCapabilities || {}),
      provider_metadata: JSON.stringify({ agentInfo: this.initializeResponse?.agentInfo || null, modes: response.modes || null, configOptions: response.configOptions || null }),
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
    if (this.child && !this.child.killed) this.child.kill();
    this.child = null;
    this.lastError = reason;
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
    this.requireAuthenticated();
    const controller = new AbortController();
    state.promptController = controller;
    await this.options.updateSession(localSessionId, { status: 'running', updated_at: Date.now() });
    await this.options.appendEvent(localSessionId, 'turn/started', { provider:'gemini', providerSessionId:state.providerSessionId });
    const started = Date.now();
    const task = this.agent!.request(methods.agent.session.prompt, {
      sessionId: state.providerSessionId,
      prompt,
    }, { cancellationSignal: controller.signal }).then(async response => {
      await this.options.appendEvent(localSessionId, 'turn/completed', { provider:'gemini', providerSessionId:state.providerSessionId, response, elapsedMs:Date.now() - started });
      await this.options.updateSession(localSessionId, { status: 'idle', active_turn_id: null, updated_at: Date.now() });
      return response;
    }).catch(async e => {
      const message = e?.message || String(e);
      await this.options.appendEvent(localSessionId, 'turn/failed', { provider:'gemini', providerSessionId:state.providerSessionId, error:{ message } });
      await this.options.updateSession(localSessionId, { status: 'interrupted', active_turn_id: null, interruption_reason: 'gemini_prompt_failed', updated_at: Date.now() });
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

  async recoverSession(localSessionId: string, providerSessionId: string | null, cwd: string) {
    await this.ensureInitialized();
    this.requireAuthenticated();
    if (providerSessionId && this.initializeResponse?.agentCapabilities?.loadSession) {
      try {
        const response = await this.agent!.request(methods.agent.session.load, { sessionId:providerSessionId, cwd, mcpServers:[] } as any);
        if (response !== undefined) {
          const state = { localSessionId, providerSessionId, cwd, activePrompt:null, promptController:null };
          this.sessions.set(localSessionId, state);
          this.providerToLocal.set(providerSessionId, localSessionId);
          await this.options.appendEvent(localSessionId, 'runtime/recovering', { provider:'gemini', loaded:true, providerSessionId });
          return state;
        }
      } catch (e:any) {
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
    this.options.logger?.info({ provider:'gemini', profileId:this.options.profileId, pid:child.pid, env:envSummary, agentInfo:initialized.agentInfo, capabilities:initialized.agentCapabilities, authRequired:!!initialized.authMethods?.length }, 'gemini acp initialized');
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
    const filePath = this.safeSessionPath(localSessionId, requestedPath, false);
    const text = await readFile(filePath, 'utf8');
    const lines = text.split(/\r?\n/);
    const start = Math.max(0, line - 1);
    const selected = lines.slice(start, limit ? start + Math.min(limit, 2000) : start + 2000).join('\n');
    return { content: selected };
  }

  private async writeTextFile(providerSessionId: string, requestedPath: string, content: string) {
    const localSessionId = this.providerToLocal.get(providerSessionId);
    if (!localSessionId) throw new Error('unknown session');
    const filePath = this.safeSessionPath(localSessionId, requestedPath, true);
    await mkdir(path.dirname(filePath), { recursive:true });
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, content, { flag:'wx' });
    await rename(tmp, filePath);
    return {};
  }

  private safeSessionPath(localSessionId: string, requestedPath: string, write: boolean) {
    const session = this.sessions.get(localSessionId);
    if (!session) throw new Error('unknown session');
    const cwdRoot = realpathSync(session.cwd);
    const attachmentRoot = path.join(this.options.dataDir, 'attachments', localSessionId);
    const resolved = path.resolve(requestedPath);
    const parent = existsSync(resolved) ? realpathSync(resolved) : realpathSync(path.dirname(resolved));
    if (parent === cwdRoot || parent.startsWith(cwdRoot + path.sep)) return resolved;
    if (!write && existsSync(attachmentRoot)) {
      const ar = realpathSync(attachmentRoot);
      if (parent === ar || parent.startsWith(ar + path.sep)) return resolved;
    }
    throw new Error('path outside allowed Gemini session roots');
  }

  private requireAuthenticated() {
    if (this.initializeResponse?.authMethods?.length) {
      throw new Error('Gemini CLI requires login or API key before ACP sessions can run');
    }
  }

  private geminiBin() {
    return process.env.GEMINI_BIN || '/usr/bin/gemini';
  }

  private geminiArgs() {
    return (process.env.GEMINI_ACP_ARGS || '--acp').split(/\s+/).filter(Boolean);
  }

  private profileDir() {
    return this.options.profileDir;
  }
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
