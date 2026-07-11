import type { Db } from './db.js';

export type DurableRuntimeEvent={session_id:string;threadId:string;generation:string;sequence:number;event_type:string;payload_json:string;created_at:number};
type Pending={eventType:string;payload:unknown;eventKey:string|null;resolve:(event:DurableRuntimeEvent)=>void;reject:(error:unknown)=>void};
type Lane={chain:Promise<void>;batch:Pending[];bytes:number;timer?:NodeJS.Timeout;operations:number};
type EventStoreMetrics={appendQueueCount:number;deltaQueueEventCount:number;deltaQueueBytes:number;pendingSqliteWriteCount:number;sqliteBatches:number;sqliteRows:number;sqliteMs:number};

/** A session's append calls enter one FIFO lane before they touch a delta batch. */
export class DurableEventStore {
  readonly metrics:EventStoreMetrics={appendQueueCount:0,deltaQueueEventCount:0,deltaQueueBytes:0,pendingSqliteWriteCount:0,sqliteBatches:0,sqliteRows:0,sqliteMs:0};
  private lanes=new Map<string,Lane>();
  constructor(private db:Db,private generation:string,private options:{windowMs?:number;maxEvents?:number;maxBytes?:number;onCommitted?:(event:DurableRuntimeEvent)=>void|Promise<void>}={}){}

  append(sessionId:string,eventType:string,payload:unknown,eventKey:string|null,critical:boolean,delta:boolean):Promise<DurableRuntimeEvent>{
    this.metrics.appendQueueCount++;
    return new Promise((resolve,reject)=>{let settled=false;const finish=()=>{if(!settled){settled=true;this.metrics.appendQueueCount=Math.max(0,this.metrics.appendQueueCount-1);}};const pending:Pending={eventType,payload,eventKey,resolve:event=>{finish();resolve(event);},reject:error=>{finish();reject(error);}};void this.queue(sessionId,async lane=>{
      if(delta&&!critical){
        lane.batch.push(pending); lane.bytes+=Buffer.byteLength(JSON.stringify(payload)); this.updateDeltaMetrics();
        if(lane.batch.length>=(this.options.maxEvents||128)||lane.bytes>=(this.options.maxBytes||256*1024)) await this.flushLane(sessionId,lane);
        else if(!lane.timer) lane.timer=setTimeout(()=>this.queue(sessionId,l=>this.flushLane(sessionId,l)),this.options.windowMs||32);
      } else { await this.flushLane(sessionId,lane); await this.commitOne(sessionId,pending); }
    }).catch(pending.reject);});
  }
  async flush(sessionId:string){ await this.queue(sessionId,lane=>this.flushLane(sessionId,lane)); }
  async drain(){ await Promise.all([...this.lanes.keys()].map(id=>this.flush(id))); await Promise.all([...this.lanes.values()].map(l=>l.chain)); }

  private queue(sessionId:string,fn:(lane:Lane)=>Promise<void>|void):Promise<void>{
    const lane=this.lanes.get(sessionId)||{chain:Promise.resolve(),batch:[],bytes:0,operations:0}; this.lanes.set(sessionId,lane); lane.operations++;
    const task=lane.chain.then(()=>fn(lane)); lane.chain=task.catch(()=>undefined);
    return task.finally(()=>{lane.operations--;this.cleanup(sessionId,lane);});
  }
  private cleanup(sessionId:string,lane:Lane){if(!lane.operations&&!lane.batch.length&&!lane.timer&&this.lanes.get(sessionId)===lane)this.lanes.delete(sessionId);}
  private updateDeltaMetrics(){this.metrics.deltaQueueEventCount=[...this.lanes.values()].reduce((n,l)=>n+l.batch.length,0);this.metrics.deltaQueueBytes=[...this.lanes.values()].reduce((n,l)=>n+l.bytes,0);}
  private async flushLane(sessionId:string,lane:Lane){
    if(lane.timer){clearTimeout(lane.timer);lane.timer=undefined;}
    const batch=lane.batch;lane.batch=[];lane.bytes=0;this.updateDeltaMetrics();if(!batch.length)return;
    // Keyed events deliberately stay sequential: MAX(sequence) and dedupe are
    // observed inside this same lane, never through Promise.all.
    if(batch.some(item=>item.eventKey)){for(const item of batch)await this.commitOne(sessionId,item);return;}
    this.metrics.pendingSqliteWriteCount++;const started=Date.now();
    try{await this.assertNoGap(sessionId);const row=await this.db.get('SELECT COALESCE(MAX(sequence),0) AS sequence FROM events WHERE session_id=?1',[sessionId]);let sequence=Number(row?.sequence||0);const now=Date.now();const events=batch.map(item=>({session_id:sessionId,threadId:sessionId,generation:this.generation,sequence:++sequence,event_type:item.eventType,payload_json:JSON.stringify(item.payload),created_at:now}));
      this.db.transactionRun(events.flatMap(event=>[{sql:'INSERT INTO events (session_id,ts,kind,payload,sequence,event_type,payload_json,created_at,event_key) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,NULL)',params:[event.session_id,event.created_at,event.event_type,event.payload_json,event.sequence,event.event_type,event.payload_json,event.created_at]},{sql:'UPDATE sessions SET last_sequence=?1,updated_at=?2 WHERE (id=?3 OR codex_thread_id=?3) AND COALESCE(last_sequence,0)<?1',params:[event.sequence,event.created_at,event.session_id]}]));
      this.metrics.sqliteBatches++;this.metrics.sqliteRows+=events.length;this.metrics.sqliteMs+=Date.now()-started;for(let i=0;i<events.length;i++){batch[i].resolve(events[i]);try{await this.options.onCommitted?.(events[i]);}catch{/* SQLite commit is authoritative; transport publication recovers from durable replay. */}}
    }catch(error){for(const item of batch)item.reject(error);}finally{this.metrics.pendingSqliteWriteCount--;}
  }
  private async commitOne(sessionId:string,pending:Pending){this.metrics.pendingSqliteWriteCount++;const started=Date.now();try{await this.assertNoGap(sessionId);if(pending.eventKey){const existing=await this.db.get('SELECT session_id,sequence,event_type,payload_json,created_at FROM events WHERE session_id=?1 AND event_key=?2',[sessionId,pending.eventKey]);if(existing){pending.resolve({...existing,threadId:sessionId,generation:this.generation,sequence:Number(existing.sequence)} as DurableRuntimeEvent);return;}}
    const row=await this.db.get('SELECT COALESCE(MAX(sequence),0) AS sequence FROM events WHERE session_id=?1',[sessionId]);const event:DurableRuntimeEvent={session_id:sessionId,threadId:sessionId,generation:this.generation,sequence:Number(row?.sequence||0)+1,event_type:pending.eventType,payload_json:JSON.stringify(pending.payload),created_at:Date.now()};this.db.transactionRun([{sql:'INSERT INTO events (session_id,ts,kind,payload,sequence,event_type,payload_json,created_at,event_key) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)',params:[event.session_id,event.created_at,event.event_type,event.payload_json,event.sequence,event.event_type,event.payload_json,event.created_at,pending.eventKey]},{sql:'UPDATE sessions SET last_sequence=?1,updated_at=?2 WHERE (id=?3 OR codex_thread_id=?3) AND COALESCE(last_sequence,0)<?1',params:[event.sequence,event.created_at,event.session_id]}]);this.metrics.sqliteBatches++;this.metrics.sqliteRows++;this.metrics.sqliteMs+=Date.now()-started;pending.resolve(event);try{await this.options.onCommitted?.(event);}catch{/* durable commit succeeded; subscriber replay remains the recovery path */}
  }catch(error){pending.reject(error);}finally{this.metrics.pendingSqliteWriteCount--;}}
  private async assertNoGap(sessionId:string){const row=await this.db.get('SELECT COUNT(*) AS count,COALESCE(MIN(sequence),0) AS first,COALESCE(MAX(sequence),0) AS last FROM events WHERE session_id=?1',[sessionId]);const count=Number(row?.count||0),first=Number(row?.first||0),last=Number(row?.last||0);if(count&&(first!==1||count!==last))throw new Error(`durable event sequence gap for ${sessionId}`);}
}
