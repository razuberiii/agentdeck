import type { ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';

export type AntigravityTurnState = 'running' | 'output_draining' | 'completed' | 'failed' | 'interrupted';
export const DEFAULT_ANTIGRAVITY_TURN_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export type AntigravityProcessResult = {
  output:string;
  stderrSummary:string;
  code:number | null;
  signal:NodeJS.Signals | null;
  timedOut:boolean;
};

export class AntigravityProcessError extends Error {
  constructor(message:string, readonly result:AntigravityProcessResult, readonly kind:'exit'|'signal'|'spawn'|'timeout'|'empty') {
    super(message);
    this.name = 'AntigravityProcessError';
  }
}

export function stableAntigravityAssistantId(threadId:string, turnId:string) {
  return `antigravity-${crypto.createHash('sha256').update(`${threadId}\0${turnId}`).digest('hex').slice(0, 32)}`;
}

type FinalizeOptions = {
  assistantId:string;
  text:string;
  status:'completed'|'failed'|'interrupted';
  error?:string;
  persistAssistant:(id:string, text:string)=>Promise<void>;
  updateSession:(status:'idle'|'failed'|'interrupted')=>Promise<void>;
  notify:(message:any)=>void;
  beforeTerminal?:()=>Promise<void>;
};

export async function finalizeAntigravityTurn(options:FinalizeOptions) {
  const sessionStatus = options.status === 'completed' ? 'idle' : options.status;
  await options.persistAssistant(options.assistantId, options.text);
  await options.updateSession(sessionStatus);
  options.notify({ type:'codex', method:'item/completed', params:{ item:{ id:options.assistantId, type:'agentMessage', text:options.text, phase:'final_answer' } } });
  await options.beforeTerminal?.();
  if (options.status === 'completed') {
    options.notify({ type:'codex', method:'turn/completed', params:{ turn:{ status:'completed' } } });
  } else {
    options.notify({
      type:'codex',
      method:options.status === 'interrupted' ? 'turn/interrupted' : 'turn/failed',
      params:{ error:{ message:options.error || `Antigravity ${options.status}` }, turn:{ status:options.status } },
    });
  }
}

type RunOptions = {
  timeoutMs:number;
  cleanOutput:(text:string)=>string;
  onTimeout?:()=>void | Promise<void>;
  onDelta?:(delta:string)=>void;
  onState?:(state:AntigravityTurnState)=>void | Promise<void>;
};

export function safeAntigravitySummary(value:string, limit = 1000) {
  return String(value || '')
    .replace(/\bBearer\s+\S+/ig, 'Bearer [redacted]')
    .replace(/([?&](?:code|token|access_token|refresh_token|id_token|client_secret)=)[^&\s]+/ig, '$1[redacted]')
    .replace(/\b(authorization|cookie|token|secret|password|access_token|refresh_token|id_token|client_secret)\s*[:=]\s*[^\s,;]+/ig, '$1=[redacted]')
    .replace(/\b[A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|COOKIE|AUTHORIZATION)[A-Za-z0-9_]*=[^\s]+/g, '[redacted-env]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

export function runAntigravityChild(child:ChildProcess, options:RunOptions):Promise<AntigravityProcessResult> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let streamed = '';
    let exitCode:number | null = null;
    let exitSignal:NodeJS.Signals | null = null;
    let spawnError:Error | null = null;
    let timedOut = false;
    let settled = false;

    const setState = (state:AntigravityTurnState) => { void options.onState?.(state); };
    const timeout = options.timeoutMs > 0 ? setTimeout(() => {
      // Antigravity is a detached process-group. Its Runtime execution owner
      // supplies timeout cancellation and group termination; this helper only
      // classifies a timeout when explicitly used by a non-detached caller.
      timedOut = true;
      void options.onTimeout?.();
    }, options.timeoutMs) : null;
    timeout?.unref?.();

    child.stdout?.on('data', chunk => {
      stdout += chunk.toString();
      const cleaned = options.cleanOutput(stdout);
      if (cleaned.length > streamed.length && cleaned.startsWith(streamed)) {
        const delta = cleaned.slice(streamed.length);
        streamed = cleaned;
        if (delta) options.onDelta?.(delta);
      }
    });
    child.stderr?.on('data', chunk => { stderr += chunk.toString(); });
    child.on('exit', (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      setState('output_draining');
    });
    child.on('error', error => {
      spawnError = error;
      setState('output_draining');
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      exitCode = code ?? exitCode;
      exitSignal = signal ?? exitSignal;
      const output = options.cleanOutput(stdout);
      const stderrSummary = safeAntigravitySummary(stderr);
      const result = { output, stderrSummary, code:exitCode, signal:exitSignal, timedOut };
      if (spawnError) {
        setState('failed');
        reject(new AntigravityProcessError(`Antigravity spawn error: ${safeAntigravitySummary(spawnError.message)}${stderrSummary ? `; ${stderrSummary}` : ''}`, result, 'spawn'));
      } else if (timedOut) {
        setState('failed');
        reject(new AntigravityProcessError(`Antigravity timed out${stderrSummary ? `: ${stderrSummary}` : ''}`, result, 'timeout'));
      } else if (exitSignal) {
        setState('interrupted');
        reject(new AntigravityProcessError(`Antigravity terminated by signal ${exitSignal}${stderrSummary ? `: ${stderrSummary}` : ''}`, result, 'signal'));
      } else if (exitCode !== 0) {
        setState('failed');
        reject(new AntigravityProcessError(`Antigravity exited with code ${exitCode}${stderrSummary ? `: ${stderrSummary}` : ''}`, result, 'exit'));
      } else if (!output) {
        setState('failed');
        reject(new AntigravityProcessError(`Antigravity returned no output${stderrSummary ? `: ${stderrSummary}` : ''}`, result, 'empty'));
      } else {
        setState('completed');
        resolve(result);
      }
    });
  });
}
