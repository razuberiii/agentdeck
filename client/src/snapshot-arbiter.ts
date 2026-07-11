export type SnapshotRequest = { request:number; sessionGeneration:number; appliedSequence:number; runtimeGeneration:string };

export class SnapshotArbiter {
  private issued=0;
  begin(sessionGeneration:number,appliedSequence:number,runtimeGeneration:string):SnapshotRequest {
    return {request:++this.issued,sessionGeneration,appliedSequence,runtimeGeneration};
  }
  accepts(token:SnapshotRequest,current:{sessionGeneration:number;appliedSequence:number;runtimeGeneration:string},snapshot:{coveredSequence:number;runtimeGeneration:string}) {
    if(token.request!==this.issued || token.sessionGeneration!==current.sessionGeneration)return false;
    // A generation-only websocket transition is meaningful even when no new
    // durable sequence was produced.  Do not let an HTTP response from the
    // generation observed at request start move the client back afterwards.
    if(current.runtimeGeneration!==token.runtimeGeneration && snapshot.runtimeGeneration!==current.runtimeGeneration)return false;
    if(snapshot.coveredSequence>=current.appliedSequence)return true;
    const generationChanged=!!snapshot.runtimeGeneration && snapshot.runtimeGeneration!==token.runtimeGeneration;
    const socketAdvanced=current.appliedSequence>token.appliedSequence;
    return generationChanged || !socketAdvanced;
  }
}
