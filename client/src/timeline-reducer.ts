export type TimelineDisplayEvent = {
  key?: string;
  role?: string;
  text?: string;
  clientMessageId?: string;
  messageId?: string;
};

export type TimelineState = {
  snapshotEvents: TimelineDisplayEvent[];
  liveMessages: any[];
  coveredSequence: number;
  appliedSequence: number;
};
export type TurnUiStatus = 'idle'|'running'|'waiting_approval'|'waiting_input'|'cancelling'|'completed'|'interrupted'|'failed'|'unknown';

export function emptyTimelineState(appliedSequence = 0): TimelineState {
  return { snapshotEvents: [], liveMessages: [], coveredSequence: 0, appliedSequence };
}

export function runtimeMessageSequence(msg: any): number {
  return Number(msg?.runtimeSequence || msg?.sequence || 0);
}

export function runtimeMessageKey(msg: any): string {
  const eventId = msg?.eventId || msg?.event_id || msg?.eventKey || msg?.event_key;
  if (eventId) return `event:${eventId}`;
  const seq = runtimeMessageSequence(msg);
  if (seq) return `${msg?.threadId || msg?.sessionId || 'session'}:${msg?.runtimeGeneration || 'legacy'}:${seq}:${msg?.type || ''}:${msg?.method || msg?.status || ''}`;
  return `local:${msg?.clientMessageId || msg?.messageId || msg?.requestId || msg?.type || ''}:${JSON.stringify(msg).slice(0, 200)}`;
}

export function applyTimelineSnapshot(state: TimelineState, snapshotEvents: TimelineDisplayEvent[], throughSequence: number): TimelineState {
  const coveredSequence = Math.max(state.coveredSequence, Number(throughSequence || 0));
  const next = dedupeRuntimeMessages(state.liveMessages.filter(msg => {
    const seq = runtimeMessageSequence(msg);
    return !seq || seq > coveredSequence;
  }));
  return {
    snapshotEvents,
    liveMessages: sortRuntimeMessages(next),
    coveredSequence,
    appliedSequence: Math.max(state.appliedSequence, coveredSequence),
  };
}

export function applyTimelineMessage(state: TimelineState, msg: any): TimelineState {
  const seq = runtimeMessageSequence(msg);
  if (seq && seq <= state.coveredSequence) {
    return { ...state, appliedSequence: Math.max(state.appliedSequence, seq) };
  }
  const key = runtimeMessageKey(msg);
  if (state.liveMessages.some(item => runtimeMessageKey(item) === key)) {
    return { ...state, appliedSequence: Math.max(state.appliedSequence, seq) };
  }
  return {
    ...state,
    liveMessages: sortRuntimeMessages(dedupeRuntimeMessages([...state.liveMessages, msg])),
    appliedSequence: Math.max(state.appliedSequence, seq),
  };
}

export function dedupeRuntimeMessages(items: any[]): any[] {
  const seen = new Set<string>();
  const out: any[] = [];
  for (const item of items) {
    const key = runtimeMessageKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function sortRuntimeMessages(items: any[]): any[] {
  return [...items].sort((a, b) => {
    const as = runtimeMessageSequence(a);
    const bs = runtimeMessageSequence(b);
    if (as && bs && as !== bs) return as - bs;
    if (as && !bs) return 1;
    if (!as && bs) return -1;
    return 0;
  });
}

export function normalizeTurnStatus(value: any): TurnUiStatus {
  const s = String(value || '');
  if (s === 'waiting_approval' || s === 'waitingApproval') return 'waiting_approval';
  if (s === 'waiting_input' || s === 'waitingInput' || s === 'ask_user_question') return 'waiting_input';
  if (s === 'cancelling' || s === 'stopping') return 'cancelling';
  if (s === 'running' || s === 'output_draining') return 'running';
  if (s === 'completed') return 'completed';
  if (s === 'failed') return 'failed';
  if (s === 'interrupted') return 'interrupted';
  if (s === 'idle' || s === 'notLoaded' || s === 'active') return 'idle';
  return 'unknown';
}

export function resolveTurnUiStatus(session: any, approvals: any[] = [], cancelling = false, current: TurnUiStatus = 'unknown', live: any[] = []): TurnUiStatus {
  if (cancelling) return 'cancelling';
  const active = session?.activeTurn;
  if (active?.waitingKind === 'approval' || approvals.length) return 'waiting_approval';
  if (active?.waitingKind === 'input') return 'waiting_input';
  const activeStatus = normalizeTurnStatus(active?.status);
  if (active?.turnId && activeStatus !== 'unknown' && activeStatus !== 'idle' && activeStatus !== 'completed') return activeStatus;
  if (active?.turnId) return 'running';
  if (live.some(m => m?.type === 'codex' && (m.method === 'turn/started' || m.method === 'item/agentMessage/delta'))) return 'running';
  if (current !== 'unknown' && current !== 'completed') return current;
  const sessionStatus = normalizeTurnStatus(session?.status);
  if (['running','waiting_approval','waiting_input','cancelling','failed','interrupted'].includes(sessionStatus)) return sessionStatus;
  return 'idle';
}
