import type {Db} from './db.js';
export const SESSION_RELATION_TABLES=['events','artifacts','artifact_baselines','agent_messages','message_receipts','interactive_requests','plan_tasks'] as const;
export function deleteSessionRelations(db:Db,sessionId:string,deleteSessionSql='DELETE FROM sessions WHERE id=?1'){
  const params=[sessionId];
  db.transactionRun([...SESSION_RELATION_TABLES.map(table=>({sql:`DELETE FROM ${table} WHERE session_id=?1`,params})),{sql:deleteSessionSql,params}]);
}
