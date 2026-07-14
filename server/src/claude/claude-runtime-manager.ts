import { query, type CanUseTool, type PermissionResult, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import path from 'node:path';
import type { Db } from '../db.js';
import type { ClaudeProfileStore } from './claude-profile-store.js';
import type { ClaudeProfile, ClaudeTurnInput } from './claude-types.js';
import { mapClaudeSdkMessage } from './claude-event-mapper.js';
import { redactClaudeSecrets, redactClaudeText } from './claude-redaction.js';
import { claudeProfileEnv } from './claude-profile-env.js';

type PendingApproval = {
  approvalId: string;
  localSessionId: string;
  turnId: string;
  toolName: string;
  input: Record<string, unknown>;
  resolve: (result: PermissionResult) => void;
  reject: (error: Error) => void;
  createdAt: number;
  suggestions?: any[];
};

export class ClaudeRuntimeManager {
  private active = new Map<string,{controller:AbortController;profileId:string;turnId:string;segmentId:string;clientMessageId:string;messageId:string;retryOf:string}>();
  private approvals = new Map<string, PendingApproval>();

  constructor(
    private db: Db,
    private profileStore: ClaudeProfileStore,
    private options: {
      appendEvent(sessionId: string, eventType: string, payload: any): Promise<any>;
      updateSession(sessionId: string, values: Record<string, string | number | null>): Promise<void>;
      executeQuery?: typeof query;
      logger?: { info(obj:any, msg?:string):void; warn(obj:any, msg?:string):void; error(obj:any, msg?:string):void };
    },
  ) {}

  activeTurnCount() { return this.active.size; }

  async startTurn(input: ClaudeTurnInput) {
    if (this.active.has(input.localSessionId)) throw new Error('Claude turn already running');
    const controller = new AbortController();
    this.active.set(input.localSessionId,{controller,profileId:input.profile.id,turnId:input.turnId,segmentId:input.segmentId,clientMessageId:input.clientMessageId,messageId:input.messageId,retryOf:input.retryOf});
    try {
      await this.options.updateSession(input.localSessionId, { status:'running', active_turn_id:input.turnId, executing_profile_id:input.profile.id, current_upstream_account_id:input.profile.id, last_execution_account_id:input.profile.id, updated_at:Date.now() });
      await this.options.appendEvent(input.localSessionId,'turn/started',{provider:'claude',turnId:input.turnId,segmentId:input.segmentId,clientMessageId:input.clientMessageId,messageId:input.messageId,retryOf:input.retryOf,profileId:input.profile.id});
      const env = await this.profileStore.readEnv(input.profile);
      const runtimeEnv = claudeProfileEnv(input.profile, env);
      const prompt = this.prompt(input);
      const canUseTool = this.canUseTool(input);
      for await (const message of (this.options.executeQuery || query)({
        prompt,
        options: {
          cwd: input.cwd,
          model: input.model || undefined,
          resume: input.resume || undefined,
          permissionMode: input.permissionMode,
          allowDangerouslySkipPermissions: input.permissionMode === 'bypassPermissions',
          systemPrompt: { type:'preset', preset:'claude_code' } as any,
          abortController: controller,
          canUseTool,
          pathToClaudeCodeExecutable: process.env.CLAUDE_BIN || undefined,
          env: runtimeEnv,
        } as any,
      })) {
        const providerSessionId = (message as any)?.session_id;
        if (providerSessionId) {
          await this.options.updateSession(input.localSessionId, {
            provider_session_id:String(providerSessionId),
            upstream_thread_id:String(providerSessionId),
            upstream_binding_profile_id:input.profile.id,
            updated_at:Date.now(),
          });
        }
        for (const event of mapClaudeSdkMessage(message as any)) {
          if(event)await this.options.appendEvent(input.localSessionId,event.eventType,{...event.payload,turnId:input.turnId,segmentId:input.segmentId,clientMessageId:input.clientMessageId,messageId:input.messageId,retryOf:input.retryOf});
        }
      }
      await this.options.updateSession(input.localSessionId, { status:'idle', active_turn_id:null, interruption_reason:null, updated_at:Date.now() });
    } catch (e:any) {
      const aborted = controller.signal.aborted;
      const message = redactClaudeText(e?.message || String(e));
      await Promise.allSettled([
        this.options.updateSession(input.localSessionId, { status:'interrupted', active_turn_id:null, interruption_reason:aborted ? 'manual_stop' : 'claude_turn_failed', updated_at:Date.now() }),
        this.options.appendEvent(input.localSessionId,aborted?'turn/interrupted':'turn/failed',{provider:'claude',turnId:input.turnId,segmentId:input.segmentId,clientMessageId:input.clientMessageId,messageId:input.messageId,retryOf:input.retryOf,error:{message},reason:aborted?'manual_stop':'claude_turn_failed'}),
      ]);
      if (!aborted) throw e;
    } finally {
      this.active.delete(input.localSessionId);
      for (const [id, approval] of this.approvals.entries()) {
        if (approval.localSessionId === input.localSessionId) {
          approval.resolve({ behavior:'deny', message:'Claude turn ended before approval was answered', toolUseID:id, decisionClassification:'user_reject' });
          this.approvals.delete(id);
        }
      }
    }
  }

  async cancel(sessionId: string) {
    const running = this.active.get(sessionId);
    if (!running) return { ok:true, running:false };
    running.controller.abort();
    for (const [id, approval] of this.approvals.entries()) {
      if (approval.localSessionId === sessionId) {
        approval.resolve({ behavior:'deny', message:'Turn cancelled', toolUseID:id, decisionClassification:'user_reject' });
        this.approvals.delete(id);
      }
    }
    await this.options.appendEvent(sessionId,'turn/interrupted',{provider:'claude',turnId:running.turnId,segmentId:running.segmentId,clientMessageId:running.clientMessageId,messageId:running.messageId,retryOf:running.retryOf,reason:'manual_stop'});
    return { ok:true, running:true };
  }

  async answerApproval(approvalId: string, decision: 'accept' | 'decline' | 'accept_session') {
    const pending = this.approvals.get(approvalId);
    if (!pending) return false;
    this.approvals.delete(approvalId);
    const allow = decision === 'accept' || decision === 'accept_session';
    await this.options.appendEvent(pending.localSessionId, 'approval/answered', { provider:'claude', approvalId, status:allow ? 'allowed' : 'denied', scope:decision === 'accept_session' ? 'session' : 'once' });
    pending.resolve(allow
      ? { behavior:'allow', updatedInput:pending.input, updatedPermissions:decision === 'accept_session' ? pending.suggestions : undefined, toolUseID:approvalId, decisionClassification:decision === 'accept_session' ? 'user_permanent' : 'user_temporary' }
      : { behavior:'deny', message:'Denied by user', toolUseID:approvalId, decisionClassification:'user_reject' });
    return true;
  }

  private canUseTool(turn: ClaudeTurnInput): CanUseTool {
    return async (toolName, input, options) => {
      const approvalId = options.requestId || options.toolUseID;
      const sanitizedInput = redactClaudeSecrets(input || {});
      await this.options.appendEvent(turn.localSessionId, 'approval/requested', {
        approvalId,
        requestId:approvalId,
        sessionId:turn.localSessionId,
        turnId:turn.turnId,
        provider:'claude',
        toolName,
        title:options.title || options.displayName || toolName,
        description:options.description || options.decisionReason || '',
        sanitizedInput,
        createdAt:Date.now(),
        status:'pending',
      });
      return await new Promise<PermissionResult>((resolve, reject) => {
        const onAbort = () => {
          this.approvals.delete(approvalId);
          resolve({ behavior:'deny', message:'Turn cancelled', toolUseID:approvalId, decisionClassification:'user_reject' });
        };
        options.signal.addEventListener('abort', onAbort, { once:true });
        this.approvals.set(approvalId, {
          approvalId,
          localSessionId:turn.localSessionId,
          turnId:turn.turnId,
          toolName,
          input:sanitizedInput,
          resolve,
          reject,
          createdAt:Date.now(),
          suggestions:options.suggestions || [],
        });
      });
    };
  }

  private prompt(input: ClaudeTurnInput): string | AsyncIterable<SDKUserMessage> {
    const lines = [input.text];
    const attachments = input.input.filter((item:any) => item?.type === 'attachment_path');
    if (attachments.length) {
      lines.push('Attachments are available as local server-side resources. Use only these paths when needed:');
      for (const item of attachments) lines.push(`- ${item.name || path.basename(item.path)} | ${item.mime || item.type || 'file'} | ${item.path}`);
    }
    lines.push('\nAgentDeck context: preserve existing project files, respect workspace boundaries, and ask for approval when required.');
    return lines.filter(Boolean).join('\n\n');
  }
}
