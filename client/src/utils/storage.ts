import type { Attachment } from '../api/types';

export function draftKey(id:string){ return `agentdeck:draft:${id}`; }
export function draftAttachmentsKey(id:string){ return `agentdeck:draftAttachments:${id}`; }
export function sequenceKey(id:string){ return `agentdeck:lastSequence:${id}`; }
export function storageGet(key:string){ try { return localStorage.getItem(key); } catch { return null; } }
export function storageSet(key:string,value:string){ try { localStorage.setItem(key,value); return true; } catch { return false; } }
export function storageRemove(key:string){ try { localStorage.removeItem(key); } catch {} }
export function loadDraftAttachments(id:string):Attachment[]{
  try {
    const raw=JSON.parse(storageGet(draftAttachmentsKey(id)) || '[]');
    return Array.isArray(raw) ? raw.filter((a:any)=>a?.id&&a?.name).map((a:any)=>({...a,uploading:false,error:a.error||''})) : [];
  } catch { return []; }
}
export function saveDraftAttachments(id:string, attachments:Attachment[]){
  const serializable=attachments.filter(a=>!a.uploading&&!a.error&&a.id&&a.name).map(a=>({id:a.id,name:a.name,type:a.type,size:a.size,url:a.url,previewUrl:a.previewUrl}));
  if(serializable.length) storageSet(draftAttachmentsKey(id), JSON.stringify(serializable));
  else storageRemove(draftAttachmentsKey(id));
}
