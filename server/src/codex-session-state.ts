export type CodexSessionState={active_turn_id:string|null;status:string;interruption_reason?:string|null};

export function codexSessionStateForNotification(current:CodexSessionState,method:string,params:any):CodexSessionState {
  if (method === 'turn/started' && params?.turn?.id) {
    return {...current,active_turn_id:String(params.turn.id),status:'running',interruption_reason:null};
  }
  if (method === 'thread/status/changed') {
    return current.active_turn_id
      ? {...current,status:'running'}
      : {...current,status:codexStatusName(params?.status)};
  }
  if (method === 'turn/completed') {
    return {...current,active_turn_id:null,status:codexTurnTerminalStatus(params?.turn),interruption_reason:null};
  }
  if (method === 'turn/failed' || method === 'turn/interrupted') {
    return {...current,active_turn_id:null,status:'interrupted',interruption_reason:'turn_failed_or_interrupted'};
  }
  return current;
}

function codexStatusName(value:any){
  const raw=typeof value==='string'?value:String(value?.type||value?.status||'idle');
  if(raw==='active'||raw==='running')return'running';
  if(raw==='error'||raw==='failed')return'interrupted';
  return'idle';
}
function codexTurnTerminalStatus(turn:any){const raw=String(turn?.status||turn?.state||'completed');return raw==='failed'||raw==='interrupted'||raw==='cancelled'?'interrupted':'idle';}
