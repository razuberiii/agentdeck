import type { ServerResponse } from 'node:http';
import type { DurableRuntimeEvent } from './event-store.js';

type Subscriber = { raw:ServerResponse; state:'replaying'|'live'|'closed'; buffer:DurableRuntimeEvent[]; chain:Promise<void>; pendingPushes:number; lastDeliveredSequence:number; close:()=>void };

export class EventSubscriptions {
  private sessions = new Map<string,Set<Subscriber>>();
  pendingPushCount = 0;
  pendingBufferCount = 0;

  constructor(private options:{ maxBuffer?:number; maxPendingPushes?:number; logger?:(level:'warn'|'info', data:unknown, message:string)=>void } = {}) {}

  count(sessionId?:string) {
    if (sessionId) return this.sessions.get(sessionId)?.size || 0;
    return [...this.sessions.values()].reduce((sum,set)=>sum+set.size,0);
  }

  snapshot() { return [...this.sessions.entries()].map(([sessionId,set])=>({sessionId,count:set.size})); }

  async subscribe(sessionId:string, raw:ServerResponse, after:number, latestSequence:()=>Promise<number>, replayPage:(after:number)=>Promise<{events:DurableRuntimeEvent[];nextSequence:number;hasMore:boolean}|DurableRuntimeEvent[]>, generation='') {
    const set = this.sessions.get(sessionId) || new Set<Subscriber>();
    this.sessions.set(sessionId,set);
    const subscriber:Subscriber = { raw, state:'replaying', buffer:[], chain:Promise.resolve(), pendingPushes:0,lastDeliveredSequence:after, close:()=>{} };
    const close = () => {
      if (subscriber.state === 'closed') return;
      this.pendingBufferCount = Math.max(0, this.pendingBufferCount - subscriber.buffer.length);
      subscriber.buffer.length = 0;
      subscriber.state = 'closed';
      set.delete(subscriber);
      raw.off('close', close);
      raw.off('error', close);
      if (!set.size) this.sessions.delete(sessionId);
    };
    subscriber.close = close;
    raw.once('close', close);
    raw.once('error', close);
    set.add(subscriber);
    const isClosed=()=>subscriber.state==='closed';
    try {
      // The subscriber is visible to publish() before the durable barrier is read.
      // Events committed during this await are buffered and reconciled below.
      const highWatermark = await latestSequence();
      let replayCursor=after;
      let pages=0,eventsSeen=0;
      while(replayCursor<highWatermark){
        if(++pages>1000 || eventsSeen>100_000) return this.disconnect(subscriber,'subscriber replay limit exceeded');
        const pageStart=replayCursor;
        const result=await replayPage(replayCursor);
        // Keep the small in-process test/helper API compatible while the
        // Runtime endpoint uses the paginated form.
        const page=Array.isArray(result)?{events:result,nextSequence:result.reduce((max,event)=>Math.max(max,event.sequence),replayCursor),hasMore:false}:result;
        const replayed=page.events.sort((a,b)=>a.sequence-b.sequence);
        if(!replayed.length) return this.disconnect(subscriber,'subscriber replay incomplete');
        for(const event of replayed){
          if(event.sequence<=replayCursor) continue;
          if(event.sequence>highWatermark) break;
          if(event.sequence!==replayCursor+1) return this.disconnect(subscriber,'subscriber replay sequence gap');
          await this.write(subscriber,event); replayCursor=event.sequence; eventsSeen++;
        }
        if(page.hasMore && Number(page.nextSequence)<=pageStart) return this.disconnect(subscriber,'subscriber replay did not advance');
        if(!page.hasMore && replayCursor!==highWatermark) return this.disconnect(subscriber,'subscriber replay incomplete');
      }
      if (isClosed()) return;
      let cursor=replayCursor;
      for (;;) {
        if(isClosed()) return;
        // publish() cannot interleave with this synchronous take-and-clear. Once
        // state becomes live, later events are chained instead of buffered.
        if(!subscriber.buffer.length){subscriber.state='live'; await this.writeControl(subscriber,'stream_ready',{type:'stream_ready',sessionId,runtimeGeneration:generation,replayFrom:after,caughtUpThrough:cursor,currentLatestSequence:cursor});break;}
        const batch=subscriber.buffer;
        subscriber.buffer=[];
        this.pendingBufferCount=Math.max(0,this.pendingBufferCount-batch.length);
        for(const event of batch.sort((a,b)=>a.sequence-b.sequence)){
          if(isClosed()) return;
          if(event.sequence<=cursor)continue;
          if(event.sequence!==cursor+1)return this.disconnect(subscriber,'subscriber sequence gap');
          await this.write(subscriber,event);cursor=event.sequence;
        }
      }
    } catch (error) {
      this.options.logger?.('warn',{sessionId,error},'runtime subscriber replay failed');
      this.disconnect(subscriber,'subscriber replay failed');
    }
  }

  publish(event:DurableRuntimeEvent) {
    for (const subscriber of this.sessions.get(event.session_id) || []) {
      if (subscriber.state==='replaying') {
        subscriber.buffer.push(event);
        this.pendingBufferCount++;
        if (subscriber.buffer.length>(this.options.maxBuffer||2048)) this.disconnect(subscriber,'subscriber replay buffer full');
        continue;
      }
      if (subscriber.state==='live') {
        if (subscriber.pendingPushes>=(this.options.maxPendingPushes||4096)) this.disconnect(subscriber,'subscriber backpressure limit');
        else { subscriber.pendingPushes++; subscriber.chain=subscriber.chain.then(()=>{if(event.sequence!==subscriber.lastDeliveredSequence+1)throw new Error('subscriber live sequence gap');return this.write(subscriber,event);}).catch(()=>this.disconnect(subscriber,'subscriber write failed')).finally(()=>{subscriber.pendingPushes=Math.max(0,subscriber.pendingPushes-1);}); }
      }
    }
  }

  async drain() { await Promise.all([...this.sessions.values()].flatMap(set=>[...set].map(sub=>sub.chain))); }

  closeAll() { for (const set of this.sessions.values()) for (const subscriber of set) this.disconnect(subscriber,'runtime closing'); }

  private async write(subscriber:Subscriber,event:DurableRuntimeEvent) {
    if (subscriber.state==='closed') return;
    if(event.sequence!==subscriber.lastDeliveredSequence+1) throw new Error('subscriber sequence gap');
    await this.writeControl(subscriber,'runtime',event);
    subscriber.lastDeliveredSequence=event.sequence;
  }
  private async writeControl(subscriber:Subscriber,name:string,payload:unknown) {
    if (subscriber.state==='closed') return;
    this.pendingPushCount++;
    try {
      const ok=subscriber.raw.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
      if (!ok) await new Promise<void>((resolve,reject)=>{
        const cleanup=()=>{subscriber.raw.off('drain',drain);subscriber.raw.off('close',onClose);subscriber.raw.off('error',failed);};
        const drain=()=>{cleanup();resolve();};const onClose=()=>{cleanup();resolve();};const failed=(error:unknown)=>{cleanup();reject(error);};
        subscriber.raw.once('drain',drain);subscriber.raw.once('close',onClose);subscriber.raw.once('error',failed);
      });
    } finally { this.pendingPushCount=Math.max(0,this.pendingPushCount-1); }
  }

  private disconnect(subscriber:Subscriber,reason:string) {
    this.options.logger?.('warn',{reason},'runtime subscriber disconnected for recovery');
    subscriber.close();
    if (!subscriber.raw.destroyed) subscriber.raw.destroy();
  }
}
