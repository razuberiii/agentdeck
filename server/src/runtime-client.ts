import http from 'node:http';

export class RuntimeClient {
  constructor(private baseUrl = process.env.AGENT_RUNTIME_URL || 'http://127.0.0.1:3852') {}
  private authHeaders() {
    const token = process.env.RUNTIME_TOKEN || process.env.AGENT_RUNTIME_TOKEN || '';
    return token ? { authorization:`Bearer ${token}` } : {};
  }

  health() { return this.request('GET', '/healthz'); }
  diagnostics() { return this.request('GET', '/diagnostics'); }
  ensureDefaultCodexAccount() { return this.request('POST', '/codex/accounts/default'); }
  restartDefaultCodexAccount(body:any) { return this.request('POST', '/codex/accounts/default/restart', body); }
  account() { return this.request('GET', '/codex/account'); }
  rateLimits() { return this.request('GET', '/codex/rate-limits'); }
  models(includeHidden = false) { return this.request('GET', `/codex/models?hidden=${includeHidden ? '1' : '0'}`); }
  geminiStatus() { return this.request('GET', '/gemini/status'); }
  geminiProfileStatus(profileId:string) { return this.request('GET', `/gemini/profiles/${encodeURIComponent(profileId)}/status`); }
  initializeGeminiProfile(profileId:string) { return this.request('POST', `/gemini/profiles/${encodeURIComponent(profileId)}/initialize`); }
  authenticateGeminiProfile(profileId:string, methodId:string) { return this.request('POST', `/gemini/profiles/${encodeURIComponent(profileId)}/authenticate`, { methodId }); }
  logoutGeminiProfile(profileId:string) { return this.request('POST', `/gemini/profiles/${encodeURIComponent(profileId)}/logout`); }
  restartGeminiProfile(profileId:string) { return this.request('POST', `/gemini/profiles/${encodeURIComponent(profileId)}/restart`); }
  answerGeminiApproval(requestId:string, body:any) { return this.request('POST', `/gemini/approvals/${encodeURIComponent(requestId)}`, body); }
  createCodexSession(body:any) { return this.request('POST', '/codex/sessions', body); }
  createGeminiSession(body:any) { return this.request('POST', '/gemini/sessions', body); }
  resumeCodexSession(body:any) { return this.request('POST', '/codex/sessions/resume', body); }
  listSessions(archived = false) { return this.request('GET', `/sessions?archived=${archived ? '1' : '0'}`); }
  readSession(id:string) { return this.request('GET', `/sessions/${encodeURIComponent(id)}`); }
  setSessionTitle(id:string, title:string) { return this.request('PATCH', `/sessions/${encodeURIComponent(id)}`, { title }); }
  events(id:string, after = 0, includeDeltas = false) { return this.request('GET', `/sessions/${encodeURIComponent(id)}/events?after=${encodeURIComponent(String(after))}${includeDeltas ? '&includeDeltas=1' : ''}`); }
  startTurn(id:string, body:any) { return this.request('POST', `/sessions/${encodeURIComponent(id)}/turns`, body); }
  stopTurn(id:string) { return this.request('POST', `/sessions/${encodeURIComponent(id)}/stop`); }
  subscribe(id:string, after:number, onEvent:(event:any)=>void, onStatus?:(status:'connected'|'closed'|'error', error?:any)=>void) {
    const url = new URL(`/sessions/${encodeURIComponent(id)}/subscribe?after=${encodeURIComponent(String(after))}`, this.baseUrl);
    const req = http.request(url, { method:'GET', headers:{ accept:'text/event-stream', ...this.authHeaders() } });
    let buffer = '';
    req.on('response', res => {
      if ((res.statusCode || 500) >= 400) {
        const chunks:Buffer[] = [];
        res.on('data', d => chunks.push(Buffer.from(d)));
        res.on('end', () => onStatus?.('error', new Error(Buffer.concat(chunks).toString('utf8') || `runtime subscribe ${res.statusCode}`)));
        return;
      }
      onStatus?.('connected');
      res.setEncoding('utf8');
      res.on('data', chunk => {
        buffer += chunk;
        for (;;) {
          const idx = buffer.indexOf('\n\n');
          if (idx < 0) break;
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const data = raw.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (data) {
            try { onEvent(JSON.parse(data)); } catch {}
          }
        }
      });
      res.on('close', () => onStatus?.('closed'));
    });
    req.on('error', err => onStatus?.('error', err));
    req.end();
    return () => req.destroy();
  }

  private request(method:string, path:string, body?:any) {
    const url = new URL(path, this.baseUrl);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    return new Promise<any>((resolve, reject) => {
      const req = http.request(url, {
        method,
        headers: payload ? { 'content-type':'application/json', 'content-length':String(payload.length), ...this.authHeaders() } : this.authHeaders(),
        timeout: 120_000,
      }, res => {
        const chunks:Buffer[] = [];
        res.on('data', d => chunks.push(Buffer.from(d)));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed:any = null;
          try { parsed = text ? JSON.parse(text) : null; } catch {}
          if ((res.statusCode || 500) >= 400) {
            reject(new Error(parsed?.error || text || `runtime ${res.statusCode}`));
          } else {
            resolve(parsed);
          }
        });
      });
      req.on('timeout', () => req.destroy(new Error('runtime request timed out')));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }
}
