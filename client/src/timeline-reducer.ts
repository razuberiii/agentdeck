export type TimelineDisplayEvent = {
  key?: string;
  role?: string;
  text?: string;
  clientMessageId?: string;
  messageId?: string;
  attachments?: { id?: string; url?: string; name?: string; type?: string; size?: number }[];
  meta?: string;
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
  const snapshotUserKeys = new Set(snapshotEvents.filter(e => e.role === 'user').flatMap(userIdentityKeys));
  const snapshotUserLooseTextKeys = new Set(snapshotEvents.filter(e => e.role === 'user').map(userLooseTextKey).filter(Boolean));
  const next = dedupeRuntimeMessages(state.liveMessages.filter(msg => {
    const seq = runtimeMessageSequence(msg);
    if (seq && seq <= coveredSequence) return false;
    if (msg?.type === 'user' && liveUserKeys(msg).some(key => snapshotUserKeys.has(key))) return false;
    if (msg?.type === 'user') {
      const loose = userLooseTextKey({
        role: 'user',
        text: String(msg.text || ''),
        attachments: Array.isArray(msg.attachments) ? msg.attachments : [],
      });
      if (loose && snapshotUserLooseTextKeys.has(loose)) return false;
    }
    return true;
  }));
  return {
    snapshotEvents,
    liveMessages: sortRuntimeMessages(next),
    coveredSequence,
    appliedSequence: Math.max(state.appliedSequence, coveredSequence),
  };
}

function liveUserKeys(msg: any): string[] {
  if (msg?.type !== 'user') return [];
  return userIdentityKeys({
    role: 'user',
    text: String(msg.text || ''),
    clientMessageId: msg.clientMessageId ? String(msg.clientMessageId) : undefined,
    messageId: msg.messageId ? String(msg.messageId) : undefined,
    attachments: Array.isArray(msg.attachments) ? msg.attachments : [],
  });
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

export function reconcileTimelineEvents<T extends TimelineDisplayEvent>(items: T[]): T[] {
  const out: T[] = [];
  const userIndex = new Map<string, number>();
  for (const item of items) {
    if (item.role !== 'user') {
      out.push(item);
      continue;
    }
    const keys = userIdentityKeys(item);
    let existingIndex: number | undefined;
    for (const key of keys) {
      const found = userIndex.get(key);
      if (found != null) {
        existingIndex = found;
        break;
      }
    }
    if (existingIndex == null) {
      const index = out.length;
      out.push(item);
      for (const key of keys) userIndex.set(key, index);
      continue;
    }
    out[existingIndex] = mergeTimelineUserEvents(out[existingIndex], item);
    for (const key of userIdentityKeys(out[existingIndex])) userIndex.set(key, existingIndex);
  }
  return out;
}

function userIdentityKeys(e: TimelineDisplayEvent): string[] {
  const keys: string[] = [];
  if (e.clientMessageId) keys.push(`client:${e.clientMessageId}`);
  if (e.messageId) keys.push(`message:${e.messageId}`);
  const contentKey = userContentIdentityKey(e);
  if (contentKey) keys.push(contentKey);
  return keys;
}

function userContentIdentityKey(e: TimelineDisplayEvent): string {
  const text = normalizeUserText(e.text || '');
  const attachments = normalizeUserAttachments(e.attachments || []);
  if (!attachments) return '';
  return `content:${text}\nattachments:${attachments}`;
}

function userLooseTextKey(e: TimelineDisplayEvent): string {
  if ((e.attachments || []).length) return '';
  const text = normalizeUserText(e.text || '');
  return text ? `text:${text}` : '';
}

function normalizeUserText(text: string): string {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function normalizeUserAttachments(attachments: TimelineDisplayEvent['attachments']): string {
  const items = (attachments || []).map(item => {
    const id = String(item.id || item.url || '').trim();
    const name = String(item.name || '').trim();
    const type = String(item.type || '').trim();
    return id || `${name}:${type}`;
  }).filter(Boolean).sort();
  return items.length ? items.join('|') : '';
}

function mergeTimelineUserEvents<T extends TimelineDisplayEvent>(a: T, b: T): T {
  const attachments = dedupeTimelineAttachments([...(a.attachments || []), ...(b.attachments || [])]);
  const text = String(b.text || '').trim() ? b.text : a.text;
  return {
    ...a,
    ...b,
    key: a.key,
    clientMessageId: a.clientMessageId || b.clientMessageId,
    messageId: a.messageId || b.messageId,
    text,
    attachments,
    meta: b.meta || a.meta,
  };
}

function dedupeTimelineAttachments(items: NonNullable<TimelineDisplayEvent['attachments']>) {
  const seen = new Set<string>();
  const out: NonNullable<TimelineDisplayEvent['attachments']> = [];
  for (const item of items) {
    const key = String(item.id || item.url || item.name || '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function normalizeTurnStatus(value: any): TurnUiStatus {
  const s = String(value || '');
  if (s === 'waiting_approval' || s === 'waitingApproval') return 'waiting_approval';
  if (s === 'planning' || s === 'executing_approved_plan') return 'running';
  if (s === 'waiting_plan_approval') return 'waiting_input';
  if (s === 'plan_cancelled') return 'completed';
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
  if (active?.waitingKind === 'plan') return 'waiting_input';
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
