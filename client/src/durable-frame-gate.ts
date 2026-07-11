export type GateContext={connectionGeneration:number;joinRequestId?:string;recoveryEpoch?:number};
export type GateResult={ready:any[];gap:boolean;ignored:boolean};

export class DurableFrameGate {
  private through:number;private pending=new Map<number,any[]>();private seen=new Set<string>();private context:GateContext;
  constructor(through=0,context:GateContext={connectionGeneration:0}){this.through=through;this.context=context;}
  reset(through:number,context:GateContext){this.through=through;this.context=context;this.pending.clear();this.seen.clear();}
  appliedThrough(){return this.through;}
  push(frame:any):GateResult{
    const sequence=Number(frame?.runtimeSequence||0);if(!sequence&&frame?.type!=='runtime_cursor')return{ready:[frame],gap:false,ignored:false};
    if(!this.matches(frame))return{ready:[],gap:false,ignored:true};
    const key=this.key(frame);if(this.seen.has(key))return{ready:[],gap:false,ignored:true};this.seen.add(key);
    if(frame?.type==='runtime_cursor')return this.cursor(frame);
    if(sequence<this.through)return{ready:[],gap:false,ignored:true};
    if(sequence===this.through)return{ready:[frame],gap:false,ignored:false};
    if(sequence>this.through+1){this.add(sequence,frame);return{ready:[],gap:true,ignored:false};}
    this.through=sequence;return{ready:[frame,...this.drain()],gap:false,ignored:false};
  }
  private cursor(frame:any):GateResult{const from=Number(frame?.fromSequence||0),through=Number(frame?.throughSequence||0);if(!Number.isSafeInteger(from)||!Number.isSafeInteger(through)||from<=0||through<from)return{ready:[],gap:false,ignored:true};if(through<=this.through)return{ready:[],gap:false,ignored:true};if(from>this.through+1){this.add(from,frame);return{ready:[],gap:true,ignored:false};}this.through=through;return{ready:[frame,...this.drain()],gap:false,ignored:false};}
  private drain(){const ready:any[]=[];for(;;){const next=this.through+1;const cursorKey=[...this.pending.keys()].sort((a,b)=>a-b).find(key=>key<=next&&this.pending.get(key)?.some(frame=>frame?.type==='runtime_cursor'&&Number(frame.throughSequence)>=next));const key=cursorKey??next,frames=this.pending.get(key);if(!frames?.length)break;this.pending.delete(key);for(const frame of frames){if(frame?.type==='runtime_cursor'){this.through=Math.max(this.through,Number(frame.throughSequence));ready.push(frame);}else if(Number(frame.runtimeSequence)===this.through+1){this.through++;ready.push(frame);}}}return ready;}
  private add(sequence:number,frame:any){this.pending.set(sequence,[...(this.pending.get(sequence)||[]),frame]);}
  private matches(frame:any){if(frame?.connectionGeneration!==undefined&&Number(frame.connectionGeneration)!==this.context.connectionGeneration)return false;if(frame?.joinRequestId!==undefined&&this.context.joinRequestId&&String(frame.joinRequestId)!==this.context.joinRequestId)return false;if(frame?.recoveryEpoch!==undefined&&Number(frame.recoveryEpoch)!==Number(this.context.recoveryEpoch||0))return false;return true;}
  private key(frame:any){return JSON.stringify([frame?.runtimeSequence||0,frame?.type,frame?.method,frame?.requestId,frame?.fromSequence,frame?.throughSequence,frame?.status,frame?.joinRequestId,frame?.recoveryEpoch]);}
}
