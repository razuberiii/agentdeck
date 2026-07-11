export class SessionCommandQueue {
  private tails=new Map<string,Promise<void>>();
  private depths=new Map<string,number>();
  constructor(private maxDepth=64) {}

  run<T>(sessionId:string,task:()=>Promise<T>):Promise<T> {
    const depth=this.depths.get(sessionId)||0;
    if(depth>=this.maxDepth) return Promise.reject(Object.assign(new Error('session command queue full'),{code:'command_queue_full'}));
    this.depths.set(sessionId,depth+1);
    const previous=this.tails.get(sessionId)||Promise.resolve();
    const result=previous.catch(()=>undefined).then(task);
    const tail=result.then(()=>undefined,()=>undefined).finally(()=>{
      const next=Math.max(0,(this.depths.get(sessionId)||1)-1);
      if(next) this.depths.set(sessionId,next); else {this.depths.delete(sessionId); if(this.tails.get(sessionId)===tail)this.tails.delete(sessionId);}
    });
    this.tails.set(sessionId,tail);
    return result;
  }

  depth(sessionId:string){return this.depths.get(sessionId)||0;}
}
