export type BrowserFrame=Record<string,unknown>;
export type DurableFrameGroup={sequence:number;runtimeGeneration:string;frames:BrowserFrame[];bytes:number};
export type DeliveryPhase='replaying'|'draining'|'live'|'closed';
export type DeliveryState={phase:DeliveryPhase;connectionGeneration:number;joinRequestId:string;recoveryEpoch:number;deliveredThrough:number;queuedFrames:DurableFrameGroup[];queuedBytes:number;sendChain:Promise<void>;pendingFrames:number;pendingBytes:number};

export class RecentFrameRing {
  private groups=new Map<number,DurableFrameGroup>(); private bytes=0;
  constructor(private maxSequences=2000,private maxBytes=8*1024*1024){}
  add(sequence:number,runtimeGeneration:string,frames:BrowserFrame[]){
    const bytes=Buffer.byteLength(JSON.stringify(frames));const group={sequence,runtimeGeneration,frames,bytes};const old=this.groups.get(sequence);if(old)this.bytes-=old.bytes;this.groups.set(sequence,group);this.bytes+=bytes;
    while(this.groups.size>this.maxSequences||this.bytes>this.maxBytes){const first=this.groups.keys().next().value as number|undefined;if(first===undefined)break;this.bytes-=this.groups.get(first)!.bytes;this.groups.delete(first);}
    return group;
  }
  range(after:number,through:number):DurableFrameGroup[]|null{
    if(through<=after)return[];const out:DurableFrameGroup[]=[];for(let sequence=after+1;sequence<=through;sequence++){const group=this.groups.get(sequence);if(!group)return null;out.push(group);}return out;
  }
  snapshot(){return{firstSequence:this.groups.keys().next().value??null,lastSequence:[...this.groups.keys()].at(-1)??null,sequences:this.groups.size,bytes:this.bytes};}
}

export class BrowserDeliveryHub {
  private rings=new Map<string,RecentFrameRing>();private states=new Map<any,Map<string,DeliveryState>>();
  constructor(private options:{maxSequences?:number;maxRingBytes?:number;maxQueuedFrames?:number;maxQueuedBytes?:number}={}){}
  ring(sessionId:string){let ring=this.rings.get(sessionId);if(!ring){ring=new RecentFrameRing(this.options.maxSequences,this.options.maxRingBytes);this.rings.set(sessionId,ring);}return ring;}
  state(ws:any,sessionId:string){return this.states.get(ws)?.get(sessionId);}
  beginReplay(ws:any,sessionId:string,meta:{connectionGeneration:number;joinRequestId:string;recoveryEpoch:number},after:number,through:number){
    const groups=this.ring(sessionId).range(after,through);if(!groups)return null;let map=this.states.get(ws);if(!map){map=new Map();this.states.set(ws,map);}const old=map.get(sessionId);if(old)old.phase='closed';const state:DeliveryState={phase:'replaying',...meta,deliveredThrough:after,queuedFrames:[],queuedBytes:0,sendChain:Promise.resolve(),pendingFrames:0,pendingBytes:0};map.set(sessionId,state);return{state,groups};
  }
  async finishReplay(ws:any,sessionId:string,state:DeliveryState,groups:DurableFrameGroup[],joined:BrowserFrame){
    for(const group of groups){if(!this.current(ws,sessionId,state))return;await this.sendGroup(ws,state,group,true);}
    state.phase='draining';
    for(;;){if(!this.current(ws,sessionId,state))return;const queued=state.queuedFrames;state.queuedFrames=[];state.queuedBytes=0;if(!queued.length){state.phase='live';break;}for(const group of queued)await this.sendGroup(ws,state,group,true);}
    await this.enqueue(ws,state,{...joined,deliveredThroughSequence:state.deliveredThrough});
  }
  publish(sessionId:string,sequence:number,runtimeGeneration:string,frames:BrowserFrame[]){
    const group=this.ring(sessionId).add(sequence,runtimeGeneration,frames);
    for(const [ws,map] of this.states){const state=map.get(sessionId);if(!state||state.phase==='closed')continue;if(state.phase==='live')void this.sendGroup(ws,state,group,false);else if(sequence>state.deliveredThrough){state.queuedFrames.push(group);state.queuedBytes+=group.bytes;if(this.overLimit(state))this.close(ws,state,'delivery_backpressure');}}
  }
  sendDirect(ws:any,frame:BrowserFrame){const states=this.states.get(ws);const state=states?.values().next().value as DeliveryState|undefined;if(state)return void this.enqueue(ws,state,frame);this.rawSend(ws,JSON.stringify(frame));}
  closeSocket(ws:any){const map=this.states.get(ws);if(map)for(const state of map.values())state.phase='closed';this.states.delete(ws);}
  private async sendGroup(ws:any,state:DeliveryState,group:DurableFrameGroup,replay:boolean){if(group.sequence<=state.deliveredThrough)return;for(const frame of group.frames)await this.enqueue(ws,state,replay?{...frame,connectionGeneration:state.connectionGeneration,joinRequestId:state.joinRequestId,recoveryEpoch:state.recoveryEpoch}:frame);state.deliveredThrough=group.sequence;}
  private enqueue(ws:any,state:DeliveryState,frame:BrowserFrame){const text=JSON.stringify(frame),bytes=Buffer.byteLength(text);state.pendingFrames++;state.pendingBytes+=bytes;if(this.overLimit(state)){this.close(ws,state,'delivery_backpressure');return Promise.reject(new Error('delivery backpressure'));}const send=state.sendChain.then(()=>this.rawSend(ws,text));state.sendChain=send.catch(()=>{this.close(ws,state,'delivery_failed');}).finally(()=>{state.pendingFrames=Math.max(0,state.pendingFrames-1);state.pendingBytes=Math.max(0,state.pendingBytes-bytes);});return send;}
  private rawSend(ws:any,text:string){return new Promise<void>((resolve,reject)=>{if(ws.readyState!==1)return reject(new Error('socket closed'));try{if(ws.send.length>=2)ws.send(text,(error?:Error)=>error?reject(error):resolve());else{ws.send(text);resolve();}}catch(error){reject(error);}});}
  private overLimit(state:DeliveryState){return state.pendingFrames+state.queuedFrames.reduce((n,g)=>n+g.frames.length,0)>(this.options.maxQueuedFrames||2048)||state.pendingBytes+state.queuedBytes>(this.options.maxQueuedBytes||8*1024*1024);}
  private close(ws:any,state:DeliveryState,reason:string){state.phase='closed';try{ws.close(1013,reason);}catch{try{ws.terminate();}catch{}}}
  private current(ws:any,sessionId:string,state:DeliveryState){return state.phase!=='closed'&&this.states.get(ws)?.get(sessionId)===state;}
}
