import type{Db}from'./db.js';

export async function claimRetryReceipt(db:Db,sessionId:string,clientMessageId:string,retryOf:string){
  const now=Date.now();
  const results=db.transactionRun([
    {sql:`INSERT OR IGNORE INTO message_retry_claims(session_id,retry_of,retry_client_message_id,created_at)
          SELECT ?1,?2,?3,?4 WHERE ?2<>?3 AND EXISTS(
            SELECT 1 FROM message_receipts WHERE session_id=?1 AND client_message_id=?2 AND status='failed'
          )`,params:[sessionId,retryOf,clientMessageId,now]},
    {sql:`INSERT OR IGNORE INTO message_receipts(session_id,client_message_id,status,retry_of,created_at,updated_at)
          SELECT ?1,?2,'received',?3,?4,?4 WHERE EXISTS(
            SELECT 1 FROM message_retry_claims WHERE session_id=?1 AND retry_of=?3 AND retry_client_message_id=?2
          )`,params:[sessionId,clientMessageId,retryOf,now]},
  ]);
  const claim=await db.get('SELECT retry_client_message_id FROM message_retry_claims WHERE session_id=?1 AND retry_of=?2',[sessionId,retryOf]);
  const canonicalClientMessageId=String(claim?.retry_client_message_id||'');
  if(!canonicalClientMessageId)return{created:false,status:'cancelled',error:'original message is not retryable',canonicalClientMessageId:''};
  const receipt=await db.get('SELECT status,error FROM message_receipts WHERE session_id=?1 AND client_message_id=?2',[sessionId,canonicalClientMessageId]);
  return{created:Number(results[0]?.changes||0)>0&&Number(results[1]?.changes||0)>0,status:String(receipt?.status||'received'),error:receipt?.error||null,canonicalClientMessageId};
}
