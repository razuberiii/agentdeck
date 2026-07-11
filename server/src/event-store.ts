import type { Db } from './db.js';

export type DurableRuntimeEvent = {
  session_id:string;
  threadId:string;
  generation:string;
  sequence:number;
  event_type:string;
  payload_json:string;
  created_at:number;
};

type Pending = { event:DurableRuntimeEvent; eventKey:string|null; resolve:(event:DurableRuntimeEvent)=>void; reject:(error:unknown)=>void };
type EventStoreMetrics = {
  appendQueueCount:number;
  deltaQueueEventCount:number;
  deltaQueueBytes:number;
  pendingSqliteWriteCount:number;
  sqliteBatches:number;
  sqliteRows:number;
  sqliteMs:number;
};

export class DurableEventStore {
  readonly metrics:EventStoreMetrics = { appendQueueCount:0, deltaQueueEventCount:0, deltaQueueBytes:0, pendingSqliteWriteCount:0, sqliteBatches:0, sqliteRows:0, sqliteMs:0 };
  private sequence = new Map<string,number>();
  private allocationChains = new Map<string,Promise<void>>();
  private writeChains = new Map<string,Promise<void>>();
  private deltaQueues = new Map<string,Pending[]>();
  private deltaBytes = new Map<string,number>();
  private timers = new Map<string,NodeJS.Timeout>();

  constructor(private db:Db, private generation:string, private options:{ windowMs?:number; maxEvents?:number; maxBytes?:number; onCommitted?:(event:DurableRuntimeEvent)=>void|Promise<void> } = {}) {}

  append(sessionId:string, eventType:string, payload:unknown, eventKey:string|null, critical:boolean, delta:boolean):Promise<DurableRuntimeEvent> {
    this.metrics.appendQueueCount++;
    return new Promise((resolve,reject) => {
      const previous = this.allocationChains.get(sessionId) || Promise.resolve();
      const allocate = previous.then(async () => {
        let current = this.sequence.get(sessionId);
        if (current === undefined) {
          const row = await this.db.get('SELECT COALESCE(MAX(sequence),0) AS sequence FROM events WHERE session_id=?1', [sessionId]);
          current = Number(row?.sequence || 0);
        }
        const event:DurableRuntimeEvent = { session_id:sessionId, threadId:sessionId, generation:this.generation, sequence:current + 1, event_type:eventType, payload_json:JSON.stringify(payload), created_at:Date.now() };
        this.sequence.set(sessionId, event.sequence);
        const pending:Pending = { event, eventKey, resolve, reject };
        if (delta && !critical) this.enqueueDelta(pending);
        else {
          await this.flush(sessionId);
          this.enqueueWrite(sessionId, [pending]);
        }
      }).catch(error => { reject(error); });
      this.allocationChains.set(sessionId, allocate.finally(() => { this.metrics.appendQueueCount = Math.max(0, this.metrics.appendQueueCount - 1); }));
    });
  }

  private enqueueDelta(pending:Pending) {
    const id = pending.event.session_id;
    const queue = this.deltaQueues.get(id) || [];
    queue.push(pending);
    this.deltaQueues.set(id, queue);
    const bytes = (this.deltaBytes.get(id) || 0) + Buffer.byteLength(pending.event.payload_json);
    this.deltaBytes.set(id, bytes);
    this.updateQueueMetrics();
    if (queue.length >= (this.options.maxEvents || 128) || bytes >= (this.options.maxBytes || 256 * 1024)) void this.flush(id);
    else if (!this.timers.has(id)) {
      const timer = setTimeout(() => void this.flush(id), this.options.windowMs || 32);
      this.timers.set(id, timer);
    }
  }

  flush(sessionId:string):Promise<void> {
    const timer = this.timers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.timers.delete(sessionId);
    const batch = this.deltaQueues.get(sessionId) || [];
    this.deltaQueues.delete(sessionId);
    this.deltaBytes.delete(sessionId);
    this.updateQueueMetrics();
    if (!batch.length) return this.writeChains.get(sessionId) || Promise.resolve();
    return this.enqueueWrite(sessionId, batch);
  }

  async drain() {
    await Promise.all(this.allocationChains.values());
    await Promise.all([...this.deltaQueues.keys()].map(id => this.flush(id)));
    await Promise.all(this.writeChains.values());
  }

  private enqueueWrite(sessionId:string, batch:Pending[]) {
    const previous = this.writeChains.get(sessionId) || Promise.resolve();
    const write = previous.then(() => this.persist(batch), error => {
      for (const pending of batch) pending.reject(error);
      throw error;
    });
    this.writeChains.set(sessionId, write.catch(() => undefined));
    return write;
  }

  private async persist(batch:Pending[]) {
    const started = Date.now();
    this.metrics.pendingSqliteWriteCount++;
    try {
      const statements = batch.flatMap(({event,eventKey}) => [
        { sql:'INSERT INTO events (session_id,ts,kind,payload,sequence,event_type,payload_json,created_at,event_key) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)', params:[event.session_id,event.created_at,event.event_type,event.payload_json,event.sequence,event.event_type,event.payload_json,event.created_at,eventKey] },
        { sql:'UPDATE sessions SET last_sequence=?1,updated_at=?2 WHERE (id=?3 OR codex_thread_id=?3) AND COALESCE(last_sequence,0)<?1', params:[event.sequence,event.created_at,event.session_id] },
      ]);
      this.db.transactionRun(statements);
      this.metrics.sqliteBatches++;
      this.metrics.sqliteRows += batch.length;
      this.metrics.sqliteMs += Date.now() - started;
      for (const pending of batch) {
        await this.options.onCommitted?.(pending.event);
        pending.resolve(pending.event);
      }
    } catch (error) {
      for (const pending of batch) pending.reject(error);
      for (const id of new Set(batch.map(item => item.event.session_id))) {
        const row = await this.db.get('SELECT COALESCE(MAX(sequence),0) AS sequence FROM events WHERE session_id=?1', [id]);
        this.sequence.set(id, Number(row?.sequence || 0));
      }
      throw error;
    } finally {
      this.metrics.pendingSqliteWriteCount = Math.max(0, this.metrics.pendingSqliteWriteCount - 1);
    }
  }

  private updateQueueMetrics() {
    this.metrics.deltaQueueEventCount = [...this.deltaQueues.values()].reduce((sum,q)=>sum+q.length,0);
    this.metrics.deltaQueueBytes = [...this.deltaBytes.values()].reduce((sum,n)=>sum+n,0);
  }
}
