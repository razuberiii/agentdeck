import type { ClaudeCanonicalEvent, ClaudeSdkMessage } from './claude-types.js';
import { redactClaudeSecrets, redactClaudeText } from './claude-redaction.js';

export function mapClaudeSdkMessage(message: ClaudeSdkMessage): ClaudeCanonicalEvent[] {
  const msg: any = redactClaudeSecrets(message);
  if (!msg || typeof msg !== 'object') return [];
  if (msg.type === 'system' && msg.subtype === 'init') {
    return [{ eventType:'claude/session_init', payload:{ provider:'claude', providerSessionId:msg.session_id, cwd:msg.cwd, model:msg.model, permissionMode:msg.permissionMode, tools:msg.tools || [], version:msg.claude_code_version || null } }];
  }
  if (msg.type === 'system' && msg.subtype === 'status') {
    return [{ eventType:'claude/status', payload:{ status:msg.status, permissionMode:msg.permissionMode, compactResult:msg.compact_result || null, compactError:redactClaudeText(msg.compact_error || '') || null } }];
  }
  if (msg.type === 'stream_event') {
    const ev = msg.event || {};
    const delta = ev.delta || {};
    const text = delta.text || delta.partial_json || '';
    if (text) return [{ eventType:'assistant/delta', payload:{ provider:'claude', itemId:`claude-${msg.session_id}`, delta:text }, persistDelta:true }];
    if (delta.thinking) return [{ eventType:'reasoning/delta', payload:{ provider:'claude', itemId:`claude-thinking-${msg.session_id}`, delta:delta.thinking }, persistDelta:true }];
    if (ev.type) return [{ eventType:'claude/stream_event', payload:{ provider:'claude', eventType:ev.type, index:ev.index ?? null } }];
  }
  if (msg.type === 'assistant') return mapAssistant(msg);
  if (msg.type === 'result') {
    const status = msg.is_error ? 'failed' : 'completed';
    const out: ClaudeCanonicalEvent[] = [];
    if (msg.result) out.push({ eventType:'assistant/final', payload:{ provider:'claude', text:redactClaudeText(msg.result), itemId:`claude-final-${msg.uuid || msg.session_id}` } });
    out.push({ eventType:status === 'completed' ? 'turn/completed' : 'turn/failed', payload:{ provider:'claude', status, stopReason:msg.stop_reason || null, terminalReason:msg.terminal_reason || null, usage:msg.usage || null, modelUsage:msg.modelUsage || null, costUsd:msg.total_cost_usd ?? null, errors:msg.errors || [] } });
    return out;
  }
  if (msg.type === 'system' && msg.subtype === 'api_retry') return [{ eventType:'claude/retry', payload:msg }];
  if (msg.type === 'system' && msg.subtype === 'compact_boundary') return [{ eventType:'claude/compact_boundary', payload:msg }];
  if (msg.type === 'system' && msg.subtype === 'permission_denied') return [{ eventType:'approval/denied', payload:{ provider:'claude', toolName:msg.tool_name, toolUseId:msg.tool_use_id, message:msg.message } }];
  if (msg.type === 'system' && msg.subtype === 'thinking_tokens') return [{ eventType:'reasoning/delta', payload:{ provider:'claude', itemId:`claude-thinking-${msg.session_id}`, delta:String(msg.text || msg.content || '') }, persistDelta:true }];
  if (msg.type === 'system' && (msg.content || msg.text)) return [{ eventType:'system', payload:{ provider:'claude', text:redactClaudeText(String(msg.content || msg.text)) } }];
  return [{ eventType:'claude/debug', payload:{ provider:'claude', type:msg.type, subtype:msg.subtype || null } }];
}

function mapAssistant(msg: any): ClaudeCanonicalEvent[] {
  const content = Array.isArray(msg.message?.content) ? msg.message.content : Array.isArray(msg.content) ? msg.content : [];
  const out: ClaudeCanonicalEvent[] = [];
  const texts: string[] = [];
  for (const block of content) {
    if (block?.type === 'text' && block.text) texts.push(redactClaudeText(block.text));
    if (block?.type === 'thinking' && block.thinking) out.push({ eventType:'reasoning', payload:{ provider:'claude', text:redactClaudeText(block.thinking) } });
    if (block?.type === 'tool_use') out.push({ eventType:'tool/use', payload:{ provider:'claude', toolCallId:block.id, toolName:block.name, input:redactClaudeSecrets(block.input || {}) } });
    if (block?.type === 'tool_result') out.push({ eventType:'tool/result', payload:{ provider:'claude', toolCallId:block.tool_use_id, content:redactClaudeSecrets(block.content || ''), isError:!!block.is_error } });
  }
  if (texts.length) out.push({ eventType:'assistant/message', payload:{ provider:'claude', text:texts.join('\n\n'), itemId:`claude-message-${msg.uuid || msg.session_id}` } });
  return out;
}

