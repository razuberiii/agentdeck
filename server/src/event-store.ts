import type { Db } from './db.js';

export type DurableRuntimeEvent = { session_id:string; threadId:string; generation:string; sequence:number; event_type:string; payload_json:string; created_at:number };
type Pending = { eventType:string; payload:unknown; eventKey:string|null; resolve:(event:DurableRuntimeEvent)=>void; reject:(error:unknown)=>void };
type EventStoreMetrics = { appendQueueCount:number; deltaQueueEventCount:number; deltaQueueBytes:number; pendingSqliteWriteCount:number; sqliteBatches:number; sqliteRows:number; sqliteMs:number };

/*
 * A session has one commit lane.  In particular, sequence allocation is inside
 * that lane, immediately before the SQLite transaction.  This deliberately
 * trades delta batching for the much more important property that a failed
 * write can never leave an already allocated later sequence in another batch.
 */
export class DurableEventStore {
  readonly metrics:EventStoreMetrics={appendQueueCount:0,deltaQueueEventCount:0,deltaQueueBytes:0,pendingSqliteWriteCount:0,sqliteBatches:0,sqliteRows:0,sqliteMs:0};
  private lanes=new Map<string,Promise<void>>();
  private checked=new Set<string>();
  private deltaQueues=new Map<string,Pending[]>(); private timers=new Map<string,NodeJS.Timeout>();
  constructor(private db:Db,private generation:string,private options:{windowMs?:number;maxEvents?:number;maxBytes?:number;onCommitted?:(event:DurableRuntimeEvent)=>void|Promise<void>}={}) {}

  append(sessionId:string,eventType:string,payload:unknown,eventKey:string|null,_critical:boolean,_delta:boolean):Promise<DurableRuntimeEvent> {
    this.metrics.appendQueueCount++;
    return new Promise((resolve,reject)=>{
      if(_delta && !_critical){
        const queue=this.deltaQueues.get(sessionId)||[]; queue.push({eventType,payload,eventKey,resolve,reject}); this.deltaQueues.set(sessionId,queue); this.metrics.deltaQueueEventCount++;
        if(queue.length >= (this.options.maxEvents || 128)) void this.flush(sessionId);
        else if(!this.timers.has(sessionId)) this.timers.set(sessionId,setTimeout(()=>void this.flush(sessionId),this.options.windowMs||32));
        return;
      }
      void this.flush(sessionId).then(()=>this.enqueue(sessionId,{eventType,payload,eventKey,resolve,reject}));
    });
  }
  private enqueue(sessionId:string,pending:Pending){
      const previous=this.lanes.get(sessionId)||Promise.resolve();
      const task=previous.then(async()=>{
        try { pending.resolve(await this.persist(sessionId,pending)); }
        catch(error) { pending.reject(error); }
        finally { this.metrics.appendQueueCount=Math.max(0,this.metrics.appendQueueCount-1); }
      });
      this.lanes.set(sessionId,task.catch(()=>undefined));
  }
  async flush(sessionId:string) { const timer=this.timers.get(sessionId);if(timer)clearTimeout(timer);this.timers.delete(sessionId);const batch=this.deltaQueues.get(sessionId)||[];this.deltaQueues.delete(sessionId);this.metrics.deltaQueueEventCount=Math.max(0,this.metrics.deltaQueueEventCount-batch.length);if(!batch.length)return;const previous=this.lanes.get(sessionId)||Promise.resolve();const task=previous.then(async()=>{try{const events=await this.persistBatch(sessionId,batch);events.forEach((event,index)=>batch[index].resolve(event));}catch(error){batch.forEach(pending=>pending.reject(error));}finally{this.metrics.appendQueueCount=Math.max(0,this.metrics.appendQueueCount-batch.length);}});this.lanes.set(sessionId,task.catch(()=>undefined));await task; }
  async drain(){ await Promise.all([...this.deltaQueues.keys()].map(id=>this.flush(id))); await Promise.all(this.lanes.values()); }

  private async persist(sessionId:string,pending:Pending):Promise<DurableRuntimeEvent>{
    this.metrics.pendingSqliteWriteCount++; const started=Date.now();
    try {
      await this.assertNoGap(sessionId);
      if(pending.eventKey){
        const existing=await this.db.get('SELECT session_id,sequence,event_type,payload_json,created_at FROM events WHERE session_id=?1 AND event_key=?2',[sessionId,pending.eventKey]);
        if(existing) return {...existing,threadId:sessionId,generation:this.generation,sequence:Number(existing.sequence)} as DurableRuntimeEvent;
      }
      const row=await this.db.get('SELECT COALESCE(MAX(sequence),0) AS sequence FROM events WHERE session_id=?1',[sessionId]);
      const event:DurableRuntimeEvent={session_id:sessionId,threadId:sessionId,generation:this.generation,sequence:Number(row?.sequence||0)+1,event_type:pending.eventType,payload_json:JSON.stringify(pending.payload),created_at:Date.now()};
      this.db.transactionRun([
        {sql:'INSERT INTO events (session_id,ts,kind,payload,sequence,event_type,payload_json,created_at,event_key) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)',params:[event.session_id,event.created_at,event.event_type,event.payload_json,event.sequence,event.event_type,event.payload_json,event.created_at,pending.eventKey]},
        {sql:'UPDATE sessions SET last_sequence=?1,updated_at=?2 WHERE (id=?3 OR codex_thread_id=?3) AND COALESCE(last_sequence,0)<?1',params:[event.sequence,event.created_at,event.session_id]},
      ]);
      this.metrics.sqliteBatches++;this.metrics.sqliteRows++;this.metrics.sqliteMs+=Date.now()-started;
      await this.options.onCommitted?.(event);
      return event;
    } finally { this.metrics.pendingSqliteWriteCount=Math.max(0,this.metrics.pendingSqliteWriteCount-1); }
  }
  private async persistBatch(sessionId:string,batch:Pending[]):Promise<DurableRuntimeEvent[]>{
    if(batch.some(item=>item.eventKey)) return Promise.all(batch.map(item=>this.persist(sessionId,item)));
    this.metrics.pendingSqliteWriteCount++;const started=Date.now();
    try{await this.assertNoGap(sessionId);const row=await this.db.get('SELECT COALESCE(MAX(sequence),0) AS sequence FROM events WHERE session_id=?1',[sessionId]);let sequence=Number(row?.sequence||0);const now=Date.now();const events=batch.map(item=>({session_id:sessionId,threadId:sessionId,generation:this.generation,sequence:++sequence,event_type:item.eventType,payload_json:JSON.stringify(item.payload),created_at:now}));const statements=events.flatMap(event=>[{sql:'INSERT INTO events (session_id,ts,kind,payload,sequence,event_type,payload_json,created_at,event_key) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,NULL)',params:[event.session_id,event.created_at,event.event_type,event.payload_json,event.sequence,event.event_type,event.payload_json,event.created_at]},{sql:'UPDATE sessions SET last_sequence=?1,updated_at=?2 WHERE (id=?3 OR codex_thread_id=?3) AND COALESCE(last_sequence,0)<?1',params:[event.sequence,event.created_at,event.session_id]}]);this.db.transactionRun(statements);this.metrics.sqliteBatches++;this.metrics.sqliteRows+=events.length;this.metrics.sqliteMs+=Date.now()-started;for(const event of events)await this.options.onCommitted?.(event);return events;
    }finally{this.metrics.pendingSqliteWriteCount=Math.max(0,this.metrics.pendingSqliteWriteCount-1);}
  }
  private async assertNoGap(sessionId:string){
    if(this.checked.has(sessionId)) return;
    const row=await this.db.get('SELECT COUNT(*) AS count,COALESCE(MIN(sequence),0) AS first,COALESCE(MAX(sequence),0) AS last FROM events WHERE session_id=?1',[sessionId]);
    const count=Number(row?.count||0),first=Number(row?.first||0),last=Number(row?.last||0);
    if(count && (first!==1 || count!==last)) throw new Error(`durable event sequence gap for ${sessionId}`);
    this.checked.add(sessionId);
  }
}
