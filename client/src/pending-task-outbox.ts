import type {BrowserOutbox,OutboxRecord} from './browser-outbox';

export async function queueAndSendPendingTask(options:{outbox:BrowserOutbox;sessionId:string;text:string;attachments:{id:string;name:string;type?:string;size?:number}[];planMode:'direct'|'plan';send:(clientMessageId:string)=>void;now?:()=>number;uuid?:()=>string}){
  const clientMessageId=(options.uuid||(()=>crypto.randomUUID()))();
  const now=(options.now||Date.now)();
  const record:OutboxRecord={clientMessageId,sessionId:options.sessionId,text:options.text,attachments:options.attachments.map(a=>({id:a.id,name:a.name,type:a.type,size:a.size})),planMode:options.planMode,createdAt:now,attempts:1,status:'ready'};
  if(await options.outbox.put(record)===false)throw new Error('无法在浏览器中保存待发送消息，请检查存储空间');
  options.send(clientMessageId);
  await options.outbox.update(clientMessageId,{status:'sent',nextAttemptAt:now+options.outbox.retryDelay(1)});
  return clientMessageId;
}
