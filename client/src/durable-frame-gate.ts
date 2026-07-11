export type GateContext={clientConnectionId:string;joinRequestId?:string;recoveryEpoch?:number};
export type GateResult={ready:any[];gap:boolean;ignored:boolean;resnapshotNeeded:boolean};
type PendingGroup={frames:Map<number,any>;frameCount:number;bytes:number};

export class DurableFrameGate{
  private through:number;private pending=new Map<number,PendingGroup>();private seen=new Map<string,number>();private context:GateContext;private pendingFrames=0;private pendingBytes=0;private limits:{sequences:number;frames:number;bytes:number};
  constructor(through=0,context:GateContext={clientConnectionId:''},limits={sequences:256,frames:2048,bytes:8*1024*1024}){this.through=through;this.context=context;this.limits=limits;}
  reset(through:number,context:GateContext){this.through=through;this.context=context;this.clearPending();this.seen.clear();}
  appliedThrough(){return this.through;}
  stats(){return{pendingSequences:this.pending.size,pendingFrames:this.pendingFrames,pendingBytes:this.pendingBytes,seen:this.seen.size};}
  push(frame:any):GateResult{
    const sequence=Number(frame?.runtimeSequence||0);if(!sequence)return{ready:[frame],gap:false,ignored:false,resnapshotNeeded:false};
    if(!this.matches(frame))return this.result([],false,true,false);
    const frameIndex=Number(frame?.frameIndex??0),frameCount=Number(frame?.frameCount??1);if(!Number.isSafeInteger(frameIndex)||!Number.isSafeInteger(frameCount)||frameIndex<0||frameCount<1||frameIndex>=frameCount)return this.result([],false,true,false);
    const key=`${sequence}:${frameIndex}:${String(frame?.frameId||'')}`;if(this.seen.has(key)||sequence<=this.through)return this.result([],false,true,false);this.seen.set(key,sequence);
    let group=this.pending.get(sequence);if(!group){group={frames:new Map(),frameCount,bytes:0};this.pending.set(sequence,group);}if(group.frameCount!==frameCount){this.clearPending();return this.result([],false,false,true);}const bytes=JSON.stringify(frame).length;group.frames.set(frameIndex,frame);group.bytes+=bytes;this.pendingFrames++;this.pendingBytes+=bytes;
    if(this.pending.size>this.limits.sequences||this.pendingFrames>this.limits.frames||this.pendingBytes>this.limits.bytes){this.clearPending();return this.result([],false,false,true);}
    const ready=this.drain();return this.result(ready,this.pending.size>0&&!this.pending.has(this.through+1),false,false);
  }
  private drain(){const ready:any[]=[];for(;;){const sequence=this.through+1,group=this.pending.get(sequence);if(!group||group.frames.size!==group.frameCount)break;const ordered=[];for(let index=0;index<group.frameCount;index++){const frame=group.frames.get(index);if(!frame)return ready;ordered.push(frame);}this.pending.delete(sequence);this.pendingFrames-=group.frameCount;this.pendingBytes-=group.bytes;ready.push(...ordered);this.through=sequence;this.pruneSeen();}return ready;}
  private clearPending(){this.pending.clear();this.pendingFrames=0;this.pendingBytes=0;}
  private pruneSeen(){const floor=this.through-128;for(const[key,sequence]of this.seen)if(sequence<floor)this.seen.delete(key);}
  private matches(frame:any){if(frame?.clientConnectionId!==undefined&&String(frame.clientConnectionId)!==this.context.clientConnectionId)return false;if(frame?.joinRequestId!==undefined&&this.context.joinRequestId&&String(frame.joinRequestId)!==this.context.joinRequestId)return false;if(frame?.recoveryEpoch!==undefined&&Number(frame.recoveryEpoch)!==Number(this.context.recoveryEpoch||0))return false;return true;}
  private result(ready:any[],gap:boolean,ignored:boolean,resnapshotNeeded:boolean){return{ready,gap,ignored,resnapshotNeeded};}
}
