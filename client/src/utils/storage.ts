import type { Attachment } from '../api/types';

export function draftKey(id:string){ return `agentdeck:draft:${id}`; }
export function draftAttachmentsKey(id:string){ return `agentdeck:draftAttachments:${id}`; }
export function sequenceKey(id:string){ return `agentdeck:lastSequence:${id}`; }
export function loadDraftAttachments(id:string):Attachment[]{
  try {
    const raw=JSON.parse(localStorage.getItem(draftAttachmentsKey(id)) || '[]');
    return Array.isArray(raw) ? raw.filter((a:any)=>a?.id&&a?.name).map((a:any)=>({...a,uploading:false,error:a.error||''})) : [];
  } catch { return []; }
}
export function saveDraftAttachments(id:string, attachments:Attachment[]){
  const serializable=attachments.filter(a=>!a.uploading&&!a.error&&a.id&&a.name).map(a=>({id:a.id,name:a.name,type:a.type,size:a.size,url:a.url,previewUrl:a.previewUrl}));
  if(serializable.length) localStorage.setItem(draftAttachmentsKey(id), JSON.stringify(serializable));
  else localStorage.removeItem(draftAttachmentsKey(id));
}
