export type RuntimeCursorFrame = {type:'runtime_cursor';fromSequence:number;throughSequence:number;runtimeGeneration:string};
type CursorLogger=(data:Record<string,unknown>,message:string)=>void;

/** Coalesces deliberately filtered durable events without exposing their payloads. */
export class RuntimeCursorBridge {
  private pending:{from:number;through:number;generation:string}|null=null;
  private timer:ReturnType<typeof setTimeout>|null=null;
  private send:(frame:RuntimeCursorFrame)=>void;
  private options:{flushMs?:number;logger?:CursorLogger;context?:()=>Record<string,unknown>};
  constructor(send:(frame:RuntimeCursorFrame)=>void,options:{flushMs?:number;logger?:CursorLogger;context?:()=>Record<string,unknown>}={}){this.send=send;this.options=options;}
  filtered(sequence:number,generation:string){
    if(!Number.isSafeInteger(sequence)||sequence<=0)return;
    if(this.pending&&(this.pending.generation!==generation||sequence!==this.pending.through+1))this.flush('boundary');
    if(!this.pending)this.pending={from:sequence,through:sequence,generation};else this.pending.through=sequence;
    this.arm();
  }
  beforeVisible(sequence:number,generation:string){if(this.pending&&(this.pending.generation!==generation||this.pending.through<sequence))this.flush('before_visible');}
  flush(reason='explicit'){
    if(this.timer)clearTimeout(this.timer);this.timer=null;
    const range=this.pending;this.pending=null;if(!range)return;
    this.send({type:'runtime_cursor',fromSequence:range.from,throughSequence:range.through,runtimeGeneration:range.generation});
    this.options.logger?.({...this.options.context?.(),runtimeGeneration:range.generation,cursorAdvanceFrom:range.from,cursorAdvanceThrough:range.through,cursorAdvanceCount:range.through-range.from+1,cursorAdvanceFlushReason:reason},'runtime cursor advance sent');
  }
  close(){if(this.timer)clearTimeout(this.timer);this.timer=null;this.pending=null;}
  private arm(){if(this.timer)return;this.timer=setTimeout(()=>this.flush('timer'),Math.max(1,this.options.flushMs??25));this.timer.unref?.();}
}
