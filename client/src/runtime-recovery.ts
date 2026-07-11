export type RecoveryIdentity={epoch:number;joinRequestId:string;targetGeneration:string;connectionGeneration:number};
export function sameRecoveryRequest(active:RecoveryIdentity|null,targetGeneration:string,connectionGeneration:number){return !!active&&active.connectionGeneration===connectionGeneration&&active.targetGeneration===targetGeneration;}
export function matchingRecoveryAck(active:RecoveryIdentity,msg:any,sessionId:string,connectionGeneration:number){
  const generation=String(msg?.runtimeGeneration||msg?.generation||'');
  return connectionGeneration===active.connectionGeneration&&String(msg?.sessionId||'')===sessionId&&Number(msg?.recoveryEpoch||0)===active.epoch&&String(msg?.joinRequestId||'')===active.joinRequestId&&(!active.targetGeneration||generation===active.targetGeneration);
}

export type RecoveryRef<T>={current:T|null};

/** Temporarily bypasses the recovery guard only for durable frames. */
export function dispatchRecoveryFrames<T,F>(frames:F[],ref:RecoveryRef<T>,sequence:(frame:F)=>number,apply:(frame:F)=>void){
  for(const frame of frames){
    const recovery=ref.current;
    const suspended=!!recovery&&sequence(frame)>0;
    if(suspended)ref.current=null;
    apply(frame);
    if(suspended&&!ref.current)ref.current=recovery;
  }
}
