import type { Db } from './db.js';

export type AntigravityLegacyHistoryEntry={id:string;role:string;text:string;createdAt:number};

export async function loadAntigravityLegacyHistory(db:Db,threadId:string,limit=80):Promise<AntigravityLegacyHistoryEntry[]>{
  const rows=await db.all(
    `SELECT * FROM (
       SELECT id,role,COALESCE(original_text,text) AS text,created_at
       FROM agent_messages
       WHERE session_id=?1 AND role IN ('user','assistant')
       ORDER BY created_at DESC,id DESC
       LIMIT ?2
     )
     ORDER BY created_at ASC,id ASC`,
    [threadId,limit],
  );
  return rows.map((row:any)=>({id:String(row.id),role:String(row.role),text:String(row.text||''),createdAt:Number(row.created_at||0)}));
}
