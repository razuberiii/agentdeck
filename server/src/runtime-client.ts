import http from 'node:http';
import {RuntimeEventEnvelopeSchema}from'./contracts.js';

export class RuntimeClient {
  constructor(private baseUrl = process.env.AGENT_RUNTIME_URL || 'http://127.0.0.1:3852') {}
  private authHeaders() {
    const token = process.env.RUNTIME_TOKEN || process.env.AGENT_RUNTIME_TOKEN || '';
    return token ? { authorization:`Bearer ${token}` } : {};
  }

  health() { return this.request('GET', '/healthz'); }
  deepHealth() { return this.request('GET', '/internal/deep-health'); }
  diagnostics() { return this.request('GET', '/diagnostics'); }
  ensureDefaultCodexAccount() { return this.request('POST', '/codex/accounts/default'); }
  restartDefaultCodexAccount(body:any) { return this.request('POST', '/codex/accounts/default/restart', body); }
  account(accountId?:string|null, codexHome?:string|null) {
    return this.request('GET', `/codex/account${codexAccountQuery(accountId, codexHome)}`);
  }
  rateLimits(accountId?:string|null, codexHome?:string|null) {
    return this.request('GET', `/codex/rate-limits${codexAccountQuery(accountId, codexHome)}`);
  }
  models(includeHidden = false) { return this.request('GET', `/codex/models?hidden=${includeHidden ? '1' : '0'}`); }
  geminiStatus() { return this.request('GET', '/gemini/status'); }
  geminiProfileStatus(profileId:string) { return this.request('GET', `/gemini/profiles/${encodeURIComponent(profileId)}/status`); }
  initializeGeminiProfile(profileId:string) { return this.request('POST', `/gemini/profiles/${encodeURIComponent(profileId)}/initialize`); }
  forceInitializeGeminiProfile(profileId:string) { return this.request('POST', `/gemini/profiles/${encodeURIComponent(profileId)}/force-initialize`); }
  authenticateGeminiProfile(profileId:string, methodId:string) { return this.request('POST', `/gemini/profiles/${encodeURIComponent(profileId)}/authenticate`, { methodId }); }
  logoutGeminiProfile(profileId:string) { return this.request('POST', `/gemini/profiles/${encodeURIComponent(profileId)}/logout`); }
  restartGeminiProfile(profileId:string) { return this.request('POST', `/gemini/profiles/${encodeURIComponent(profileId)}/restart`); }
  disposeGeminiProfile(profileId:string) { return this.request('POST', `/gemini/profiles/${encodeURIComponent(profileId)}/dispose`); }
  answerGeminiApproval(requestId:string, body:any) { return this.request('POST', `/gemini/approvals/${encodeURIComponent(requestId)}`, body); }
  answerClaudeApproval(requestId:string, body:any) { return this.request('POST', `/claude/approvals/${encodeURIComponent(requestId)}`, body); }
  createCodexSession(body:any) { return this.request('POST', '/codex/sessions', body); }
  createGeminiSession(body:any) { return this.request('POST', '/gemini/sessions', body); }
  createClaudeSession(body:any) { return this.request('POST', '/claude/sessions', body); }
  setGeminiSessionModel(id:string, model:string | null) { return this.request('POST', `/gemini/sessions/${encodeURIComponent(id)}/model`, { model }); }
  resumeCodexSession(body:any) { return this.request('POST', '/codex/sessions/resume', body); }
  listSessions(archived = false) { return this.request('GET', `/sessions?archived=${archived ? '1' : '0'}`); }
  readSession(id:string) { return this.request('GET', `/sessions/${encodeURIComponent(id)}`); }
  setSessionTitle(id:string, title:string) { return this.request('PATCH', `/sessions/${encodeURIComponent(id)}`, { title }); }
  setSessionModel(id:string,model:string|null){return this.request('PATCH',`/sessions/${encodeURIComponent(id)}`,{model});}
  setSessionArchived(id:string,archived:boolean){return this.request('PATCH',`/sessions/${encodeURIComponent(id)}`,{archived});}
  deleteSession(id:string){return this.request('DELETE',`/sessions/${encodeURIComponent(id)}`);}
  events(id:string, after = 0, includeDeltas = false) { return this.request('GET', `/sessions/${encodeURIComponent(id)}/events?after=${encodeURIComponent(String(after))}${includeDeltas ? '&includeDeltas=1' : ''}`); }
  startTurn(id:string, body:any) { return this.request('POST', `/sessions/${encodeURIComponent(id)}/turns`, body); }
  stopTurn(id:string) { return this.request('POST', `/sessions/${encodeURIComponent(id)}/stop`); }
  subscribe(id:string, after:number, onEvent:(event:any)=>void|Promise<void>, onStatus?:(status:'transport_connected'|'stream_ready'|'closed'|'error', error?:any)=>void) {
    const url = new URL(`/sessions/${encodeURIComponent(id)}/subscribe?after=${encodeURIComponent(String(after))}`, this.baseUrl);
    const req = http.request(url, { method:'GET', headers:{ accept:'text/event-stream', ...this.authHeaders() } });
    let buffer = '';
    let eventQueue = Promise.resolve();
    let damaged = false;
    const fail = (error:unknown) => {
      if (damaged) return;
      damaged = true;
      const normalized = error instanceof Error ? error : new Error(String(error));
      onStatus?.('error', normalized);
      req.destroy(normalized);
    };
    req.on('response', res => {
      if ((res.statusCode || 500) >= 400) {
        const chunks:Buffer[] = [];
        res.on('data', d => chunks.push(Buffer.from(d)));
        res.on('end', () => onStatus?.('error', new Error(Buffer.concat(chunks).toString('utf8') || `runtime subscribe ${res.statusCode}`)));
        return;
      }
      // HTTP success says only that the transport exists.  The runtime emits
      // stream_ready after its replay/buffer handoff has become live.
      onStatus?.('transport_connected',{generation:String(res.headers['x-runtime-generation']||'')});
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
            try {
              const parsed=JSON.parse(data);
              if(parsed?.type==='stream_ready') eventQueue=eventQueue.then(()=>onStatus?.('stream_ready',parsed));
              else {
                const event = RuntimeEventEnvelopeSchema.parse(parsed);
                eventQueue = eventQueue.then(()=>onEvent(event)).catch(fail);
              }
            } catch (error) { fail(new Error(`runtime SSE JSON parse failed: ${error instanceof Error ? error.message : String(error)}`)); }
          }
        }
      });
      res.on('close', () => { void eventQueue.finally(() => { if (!damaged) onStatus?.('closed'); }); });
    });
    req.on('error', err => {if(!damaged){damaged=true;onStatus?.('error',err);}});
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
            const err:any = new Error(parsed?.message || parsed?.error || text || `runtime ${res.statusCode}`);
            err.statusCode = res.statusCode || 500;
            err.body = parsed || null;
            reject(err);
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

function codexAccountQuery(accountId?:string|null, codexHome?:string|null) {
  const params = new URLSearchParams();
  if (accountId) params.set('accountId', accountId);
  if (codexHome) params.set('codexHome', codexHome);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}
