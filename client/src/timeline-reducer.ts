export type TimelineDisplayEvent = {
  key?: string;
  role?: string;
  text?: string;
  clientMessageId?: string;
  messageId?: string;
  turnId?:string;
  segmentId?:string;
  retryOf?:string;
  attachments?: { id?: string; url?: string; name?: string; type?: string; size?: number }[];
  meta?: string;
  deliveryStatus?: string;
  deliveryError?: string;
};

export type TimelineState = {
  snapshotEvents: TimelineDisplayEvent[];
  liveMessages: any[];
  coveredSequence: number;
  appliedSequence: number;
  runtimeGeneration: string;
  highestSeenSequence: number;
  contiguousAppliedSequence: number;
  snapshotCoveredSequence: number;
  pendingSequenceBuffer: Map<number,any[]>;
  recovering: boolean;
};
export type TurnUiStatus = 'idle'|'running'|'waiting_approval'|'waiting_input'|'cancelling'|'completed'|'interrupted'|'failed'|'unknown';

export function emptyTimelineState(appliedSequence = 0): TimelineState {
  return { snapshotEvents: [], liveMessages: [], coveredSequence: 0, appliedSequence, runtimeGeneration:'', highestSeenSequence:appliedSequence, contiguousAppliedSequence:appliedSequence, snapshotCoveredSequence:0, pendingSequenceBuffer:new Map(), recovering:false };
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
  const snapshotUserLooseTextKeys = new Set(snapshotEvents.filter(e => e.role === 'user' && !hasStableUserId(e)).map(userLooseTextKey).filter(Boolean));
  const next = dedupeRuntimeMessages(state.liveMessages.filter(msg => {
    const seq = runtimeMessageSequence(msg);
    if (seq && seq <= coveredSequence) return false;
    if (msg?.type === 'user' && liveUserKeys(msg).some(key => snapshotUserKeys.has(key))) return false;
    if (msg?.type === 'user' && !hasStableUserId(msg)) {
      const loose = userLooseTextKey({
        role: 'user',
        text: String(msg.text || ''),
        attachments: Array.isArray(msg.attachments) ? msg.attachments : [],
      });
      if (loose && snapshotUserLooseTextKeys.has(loose)) return false;
    }
    return true;
  }));
  const pendingSequenceBuffer = new Map([...state.pendingSequenceBuffer].filter(([sequence])=>sequence>coveredSequence));
  return {
    snapshotEvents,
    liveMessages: sortRuntimeMessages(next),
    coveredSequence,
    appliedSequence: Math.max(state.appliedSequence, coveredSequence),
    snapshotCoveredSequence:coveredSequence,
    contiguousAppliedSequence:Math.max(state.contiguousAppliedSequence,coveredSequence),
    highestSeenSequence:Math.max(state.highestSeenSequence,coveredSequence),
    runtimeGeneration:state.runtimeGeneration,
    pendingSequenceBuffer,
    recovering:pendingSequenceBuffer.size>0,
  };
}

export function applyAuthoritativeTimelineSnapshot(state:TimelineState,snapshotEvents:TimelineDisplayEvent[],throughSequence:number):TimelineState{
  const through=Math.max(0,Number(throughSequence||0));
  return applyTimelineSnapshot(through<state.contiguousAppliedSequence?emptyTimelineState(through):state,snapshotEvents,through);
}

function liveUserKeys(msg: any): string[] {
  if (msg?.type !== 'user') return [];
  return userIdentityKeys({
    role: 'user',
    text: String(msg.text || ''),
    clientMessageId: msg.clientMessageId ? String(msg.clientMessageId) : undefined,
    messageId: msg.messageId ? String(msg.messageId) : undefined,
    turnId:msg.turnId?String(msg.turnId):undefined,
    segmentId:msg.segmentId?String(msg.segmentId):undefined,
    attachments: Array.isArray(msg.attachments) ? msg.attachments : [],
  });
}

export function applyTimelineMessage(state: TimelineState, msg: any): TimelineState {
  const seq = runtimeMessageSequence(msg);
  const generation=String(msg?.runtimeGeneration || msg?.generation || '');
  if (generation && state.runtimeGeneration && generation!==state.runtimeGeneration) {
    state=beginTimelineGeneration(state,generation);
  } else if (generation && !state.runtimeGeneration) state={...state,runtimeGeneration:generation};
  if(msg?.type==='runtime_cursor')return applyCursorRange(state,msg);
  if(msg?.type==='messageStatus'&&msg.clientMessageId)state=applySnapshotMessageStatus(state,msg);
  if (seq && seq <= state.coveredSequence) {
    return { ...state, appliedSequence: Math.max(state.appliedSequence, seq),contiguousAppliedSequence:Math.max(state.contiguousAppliedSequence,seq),highestSeenSequence:Math.max(state.highestSeenSequence,seq) };
  }
  if (seq>state.contiguousAppliedSequence+1) {
    const pending=new Map(state.pendingSequenceBuffer);
    pending.set(seq,[...(pending.get(seq)||[]),msg]);
    return {...state,highestSeenSequence:Math.max(state.highestSeenSequence,seq),pendingSequenceBuffer:pending,recovering:true};
  }
  return applyContiguousMessage(state,msg);
}

function applyCursorRange(state:TimelineState,msg:any):TimelineState{
  const originalFrom=Number(msg?.fromSequence||0);
  const through=Number(msg?.throughSequence||0);
  if(!Number.isSafeInteger(originalFrom)||!Number.isSafeInteger(through)||originalFrom<=0||through<originalFrom)return state;
  if(through<=state.contiguousAppliedSequence||through<=state.snapshotCoveredSequence)return state;
  const from=Math.max(originalFrom,state.contiguousAppliedSequence+1,state.snapshotCoveredSequence+1);
  if(from>state.contiguousAppliedSequence+1){
    const pending=new Map(state.pendingSequenceBuffer);
    const key=runtimeMessageKey(msg);
    const existing=pending.get(originalFrom)||[];
    if(!existing.some(item=>runtimeMessageKey(item)===key))pending.set(originalFrom,[...existing,msg]);
    return {...state,highestSeenSequence:Math.max(state.highestSeenSequence,through),pendingSequenceBuffer:pending,recovering:true};
  }
  return advancePending({...state,appliedSequence:Math.max(state.appliedSequence,through),contiguousAppliedSequence:through,highestSeenSequence:Math.max(state.highestSeenSequence,through)});
}

export function beginTimelineGeneration(state:TimelineState,generation:string):TimelineState{
  const covered=Math.max(state.snapshotCoveredSequence,state.coveredSequence);
  return {...state,liveMessages:[],coveredSequence:covered,appliedSequence:covered,runtimeGeneration:generation,highestSeenSequence:covered,contiguousAppliedSequence:covered,snapshotCoveredSequence:covered,pendingSequenceBuffer:new Map(),recovering:true};
}

function applyContiguousMessage(state:TimelineState,msg:any):TimelineState {
  const seq=runtimeMessageSequence(msg);
  const key = runtimeMessageKey(msg);
  if (state.liveMessages.some(item => runtimeMessageKey(item) === key)) {
    return advancePending({...state,appliedSequence:Math.max(state.appliedSequence,seq),contiguousAppliedSequence:Math.max(state.contiguousAppliedSequence,seq),highestSeenSequence:Math.max(state.highestSeenSequence,seq)});
  }
  const coalesced = coalesceLiveMessage(state.liveMessages, msg);
  return advancePending({
    ...state,
    liveMessages: sortRuntimeMessages(dedupeRuntimeMessages(coalesced)),
    appliedSequence: Math.max(state.appliedSequence, seq),
    contiguousAppliedSequence:seq ? Math.max(state.contiguousAppliedSequence,seq) : state.contiguousAppliedSequence,
    highestSeenSequence:Math.max(state.highestSeenSequence,seq),
  });
}

function applySnapshotMessageStatus(state:TimelineState,msg:any):TimelineState{
  const clientMessageId=String(msg.clientMessageId);
  return{...state,snapshotEvents:state.snapshotEvents.map(event=>event.role==='user'&&String(event.clientMessageId||'')===clientMessageId?{...event,deliveryStatus:String(msg.status||event.deliveryStatus||''),deliveryError:msg.error||undefined}:event)};
}

function advancePending(state:TimelineState):TimelineState {
  let next=state;
  for (;;) {
    const sequence=next.contiguousAppliedSequence+1;
    const pendingKey=[...next.pendingSequenceBuffer.keys()].sort((a,b)=>a-b).find(key=>key<=sequence&&next.pendingSequenceBuffer.get(key)?.some(msg=>msg?.type==='runtime_cursor'&&Number(msg.throughSequence)>=sequence))??sequence;
    const buffered=next.pendingSequenceBuffer.get(pendingKey);
    if (!buffered?.length) break;
    const pending=new Map(next.pendingSequenceBuffer);
    pending.delete(pendingKey);
    next={...next,pendingSequenceBuffer:pending};
    for (const message of buffered) next=message?.type==='runtime_cursor'?applyCursorRange(next,message):applyContiguousMessage(next,message);
  }
  return {...next,recovering:next.pendingSequenceBuffer.size>0};
}

function coalesceLiveMessage(items:any[], msg:any):any[] {
  if (msg?.type === 'activity') {
    const withoutPrevious = items.filter(item => item?.type !== 'activity' || item.activityId !== msg.activityId);
    return [...withoutPrevious.filter(item => item?.type !== 'activity').slice(-220), ...withoutPrevious.filter(item => item?.type === 'activity').slice(-7), msg];
  }
  if (msg?.type === 'codex' && msg?.method === 'item/agentMessage/delta') {
    const itemId = String(msg?.params?.itemId || 'live-agent');
    const index = items.findIndex(item => item?.type === 'codex' && item?.method === 'item/agentMessage/delta' && String(item?.params?.itemId || 'live-agent') === itemId);
    if (index >= 0) {
      const next = [...items];
      const previous = next[index];
      // Keep the sequence where the streaming answer first appeared. Using the
      // newest delta sequence makes the answer move below a user message sent
      // during generation until the authoritative snapshot is reloaded.
      next[index] = { ...previous, ...msg, runtimeSequence:runtimeMessageSequence(previous) || runtimeMessageSequence(msg), sequence:previous?.sequence || msg?.sequence, params:{ ...previous.params, ...msg.params, delta:String(previous.params?.delta || '') + String(msg.params?.delta || '') } };
      return next;
    }
  }
  if (msg?.type === 'codex' && msg?.method === 'turn/started') return [...items.filter(item => item?.type !== 'activity'), msg];
  return [...items, msg];
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
  const assistantIndex = new Map<string, number>();
  for (const item of items) {
    if (item.role !== 'user') {
      const assistantKey=item.role==='assistant'&&item.key?String(item.key):'';
      const prior=assistantKey?assistantIndex.get(assistantKey):undefined;
      if(prior!=null){out[prior]={...out[prior],...item,key:out[prior].key};continue;}
      if(assistantKey)assistantIndex.set(assistantKey,out.length);
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
  if (e.turnId) keys.push(`turn:${e.turnId}`);
  else if (e.segmentId) keys.push(`segment:${e.segmentId}`);
  if (!hasStableUserId(e)) { const contentKey = userContentIdentityKey(e) || userLooseTextKey(e); if (contentKey) keys.push(contentKey); }
  return keys;
}

function hasStableUserId(e:TimelineDisplayEvent):boolean { return !!(e.clientMessageId || e.messageId); }

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
  const retried = a.deliveryStatus === 'retried' || b.deliveryStatus === 'retried';
  return {
    ...a,
    ...b,
    key: a.key,
    clientMessageId: a.clientMessageId || b.clientMessageId,
    messageId: a.messageId || b.messageId,
    turnId: a.turnId || b.turnId,
    segmentId: a.segmentId || b.segmentId,
    text,
    attachments,
    meta: retried ? '已重试' : b.meta || a.meta,
    deliveryStatus:retried ? 'retried' : b.deliveryStatus||a.deliveryStatus,
    deliveryError:retried ? undefined : b.deliveryError||a.deliveryError,
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
  const structured=latestStructuredTurnEvent(live);
  if(structured?.method==='turn/started')return'running';
  if(structured?.method==='turn/completed')return turnStatusFromTerminal(structured,'completed');
  const sessionStatus = normalizeTurnStatus(session?.status);
  // An idle authoritative snapshot has already incorporated the terminal
  // event. Do not let a retained terminal frame from an older turn paint the
  // session as interrupted again after reconnect or terminal resync.
  if(structured?.method==='turn/failed')return sessionStatus==='idle'?'idle':'failed';
  if(structured?.method==='turn/interrupted')return sessionStatus==='idle'?'idle':'interrupted';
  if(live.some(m=>m?.type==='codex'&&m.method==='item/agentMessage/delta'))return'running';
  if (['running','waiting_approval','waiting_input','cancelling','failed','interrupted'].includes(sessionStatus)) return sessionStatus;
  if(['running','waiting_approval','waiting_input','cancelling'].includes(current))return current;
  return 'idle';
}
function turnStatusFromTerminal(message:any,fallback:TurnUiStatus):TurnUiStatus{const status=normalizeTurnStatus(message?.params?.turn?.status);return status==='failed'||status==='interrupted'?status:fallback;}
function latestStructuredTurnEvent(live:any[]){let latest:any=null,latestSequence=Number.NEGATIVE_INFINITY,latestIndex=-1;for(let index=0;index<live.length;index++){const event=live[index];if(event?.type!=='codex'||!['turn/started','turn/completed','turn/failed','turn/interrupted'].includes(String(event.method)))continue;const value=Number(event.runtimeSequence),sequence=Number.isFinite(value)&&value>0?value:Number.NEGATIVE_INFINITY;if(!latest||sequence>latestSequence||(sequence===latestSequence&&index>latestIndex)){latest=event;latestSequence=sequence;latestIndex=index;}}return latest;}
