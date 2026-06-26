import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import { EventEmitter } from 'node:events';

type Pending = { resolve: (v:any)=>void; reject:(e:any)=>void; timer: NodeJS.Timeout };
export class CodexBridge extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private ready: Promise<void> | null = null;
  constructor(private home = '/home/ubuntu', private codexHome = '/home/ubuntu/.codex') { super(); }
  getCodexHome() { return this.codexHome; }
  async switchCodexHome(codexHome: string) {
    if (this.codexHome === codexHome) return;
    this.codexHome = codexHome;
    await this.restart();
  }
  async restart() {
    const old = this.proc;
    this.proc = null;
    this.ready = null;
    if (old && !old.killed) old.kill('SIGTERM');
    for (const p of this.pending.values()) p.reject(new Error('codex app-server restarted'));
    this.pending.clear();
    await this.ensure();
  }
  async ensure() { if (!this.ready) this.ready = this.start(); return this.ready; }
  private async start() {
    const proc = spawn('codex', ['app-server','--listen','stdio://','-c','approval_policy="never"','-c','sandbox_mode="danger-full-access"'], { env: { ...process.env, HOME: this.home, CODEX_HOME: this.codexHome }, stdio: ['pipe','pipe','pipe'] });
    this.proc = proc;
    proc.stderr.on('data', d => this.emit('stderr', redact(d.toString())));
    proc.on('exit', (code, sig) => {
      this.emit('exit', { code, sig });
      if (this.proc !== proc) return;
      this.ready = null;
      for (const p of this.pending.values()) p.reject(new Error('codex app-server exited'));
      this.pending.clear();
    });
    const rl = readline.createInterface({ input: proc.stdout });
    rl.on('line', line => this.handleLine(line));
    await this.request('initialize', { clientInfo: { name:'codex-mobile', title:'Codex Mobile', version:'1.0.0' }, capabilities: { experimentalApi: true, requestAttestation: false } });
    this.notify('initialized');
  }
  private handleLine(line: string) {
    let msg:any; try { msg = JSON.parse(line); } catch { this.emit('raw', line); return; }
    if (msg.id !== undefined && this.pending.has(msg.id)) { const p = this.pending.get(msg.id)!; clearTimeout(p.timer); this.pending.delete(msg.id); if (msg.error) p.reject(Object.assign(new Error(msg.error.message || 'codex error'), { data: msg.error })); else p.resolve(msg.result); return; }
    if (msg.id !== undefined && msg.method) { this.emit('request', msg); return; }
    if (msg.method) this.emit('notification', msg);
  }
  request(method: string, params?: any, timeoutMs = 120000): Promise<any> {
    if (!this.proc) throw new Error('codex app-server is not running');
    const id = this.nextId++;
    const body:any = { id, method }; if (params !== undefined) body.params = params;
    this.proc.stdin.write(JSON.stringify(body) + '\n');
    return new Promise((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs); this.pending.set(id, { resolve, reject, timer }); });
  }
  respond(id: number|string, result: any) { this.proc?.stdin.write(JSON.stringify({ id, result }) + '\n'); }
  notify(method: string, params?: any) { const body:any = { method }; if (params !== undefined) body.params = params; this.proc?.stdin.write(JSON.stringify(body) + '\n'); }
  async startThread(cwd: string, opts: TurnOptions = defaultTurnOptions()) { await this.ensure(); return this.request('thread/start', { cwd, approvalPolicy: opts.approvalPolicy, sandbox: opts.sandboxMode }); }
  async resumeThread(threadId: string, cwd?: string, opts: TurnOptions = defaultTurnOptions()) { await this.ensure(); return this.request('thread/resume', { threadId, cwd, approvalPolicy: opts.approvalPolicy, sandbox: opts.sandboxMode }); }
  async readThread(threadId: string, includeTurns = true) { await this.ensure(); return this.request('thread/read', { threadId, includeTurns }); }
  async listThreads(archived = false, limit = 100) { await this.ensure(); return this.request('thread/list', { archived, limit, sortKey: 'updated_at', sortDirection: 'desc' }); }
  async setName(threadId: string, name: string) { await this.ensure(); return this.request('thread/name/set', { threadId, name }); }
  async account() { await this.ensure(); return this.request('account/read', { refreshToken: false }); }
  async rateLimits() { await this.ensure(); return this.request('account/rateLimits/read'); }
  async archive(threadId: string) { await this.ensure(); return this.request('thread/archive', { threadId }); }
  async unarchive(threadId: string) { await this.ensure(); return this.request('thread/unarchive', { threadId }); }
  async fork(threadId: string, cwd?: string, opts: TurnOptions = defaultTurnOptions()) { await this.ensure(); return this.request('thread/fork', { threadId, cwd, approvalPolicy: opts.approvalPolicy, sandbox: opts.sandboxMode }); }
  async startTurn(threadId: string, input: any[], cwd: string, opts: TurnOptions = defaultTurnOptions()) { await this.ensure(); return this.request('turn/start', { threadId, cwd, approvalPolicy: opts.approvalPolicy, sandboxPolicy: { type: sandboxPolicyType(opts.sandboxMode) }, input }); }
  async interrupt(threadId: string) { await this.ensure(); return this.request('turn/interrupt', { threadId }); }
}
export type TurnOptions = { approvalPolicy: string; sandboxMode: string };
function defaultTurnOptions(): TurnOptions { return { approvalPolicy:'never', sandboxMode:'danger-full-access' }; }
function sandboxPolicyType(mode:string) {
  if (mode === 'read-only') return 'readOnly';
  if (mode === 'workspace-write') return 'workspaceWrite';
  return 'dangerFullAccess';
}
function redact(s:string){ return s.replace(/(authorization|cookie|token|secret|password)[^\n]*/ig, '$1=[redacted]'); }
