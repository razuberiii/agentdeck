import{OutboxRecordSchema}from"../../server/src/contracts";
export type OutboxStatus='draft'|'uploading'|'ready'|'sent'|'received'|'persisted'|'accepted'|'failed'|'cancelled';
export type OutboxRecord={clientMessageId:string;sessionId:string;text:string;attachments:{id:string;name:string;type?:string;size?:number}[];planMode:'direct'|'plan';createdAt:number;attempts:number;status:OutboxStatus;lastError?:string;nextAttemptAt?:number};
const DB='agentdeck-outbox'; const STORE='messages'; const FALLBACK='agentdeck:outbox:fallback'; const MAX=200; const MAX_ATTEMPTS=8;

export class BrowserOutbox {
  private openDb():Promise<IDBDatabase>{return new Promise((resolve,reject)=>{if(!globalThis.indexedDB)return reject(new Error('IndexedDB unavailable'));const request=indexedDB.open(DB,1);request.onupgradeneeded=()=>request.result.createObjectStore(STORE,{keyPath:'clientMessageId'});request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}
  async put(record:OutboxRecord){record=OutboxRecordSchema.parse(record) as OutboxRecord;if(record.attempts>MAX_ATTEMPTS)record={...record,status:'failed',lastError:record.lastError||'maximum retry attempts reached'};try{const db=await this.openDb();await new Promise<void>((resolve,reject)=>{const tx=db.transaction(STORE,'readwrite');tx.objectStore(STORE).put(record);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});db.close();await this.trim();}catch{this.fallbackPut(record);}}
  async list(sessionId?:string):Promise<OutboxRecord[]>{try{const db=await this.openDb();const rows=await new Promise<OutboxRecord[]>((resolve,reject)=>{const req=db.transaction(STORE).objectStore(STORE).getAll();req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});db.close();return rows.filter(row=>!sessionId||row.sessionId===sessionId).sort((a,b)=>a.createdAt-b.createdAt);}catch{return this.fallbackList().filter(row=>!sessionId||row.sessionId===sessionId);}}
  async update(id:string,patch:Partial<OutboxRecord>){const current=(await this.list()).find(row=>row.clientMessageId===id);if(current)await this.put({...current,...patch});}
  async removeBodyAfterPersisted(id:string){const current=(await this.list()).find(row=>row.clientMessageId===id);if(current&&['persisted','accepted'].includes(current.status))await this.put({...current,text:''});}
  retryDelay(attempts:number){return Math.min(30_000,500*2**Math.max(0,attempts-1));}
  private async trim(){const rows=await this.list();for(const row of rows.slice(0,Math.max(0,rows.length-MAX)))if(['persisted','accepted','cancelled'].includes(row.status))await this.delete(row.clientMessageId);}
  private async delete(id:string){const db=await this.openDb();await new Promise<void>((resolve,reject)=>{const tx=db.transaction(STORE,'readwrite');tx.objectStore(STORE).delete(id);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});db.close();}
  private fallbackList():OutboxRecord[]{try{const rows=JSON.parse(localStorage.getItem(FALLBACK)||'[]');return Array.isArray(rows)?rows.slice(-50):[];}catch{return[];}}
  private fallbackPut(record:OutboxRecord){const rows=this.fallbackList().filter(row=>row.clientMessageId!==record.clientMessageId);rows.push(record);localStorage.setItem(FALLBACK,JSON.stringify(rows.slice(-50)));}
}
