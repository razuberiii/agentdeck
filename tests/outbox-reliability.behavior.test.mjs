import assert from'node:assert/strict';import{execFileSync}from'node:child_process';import test from'node:test';
const moduleUrl=new URL('../client/src/browser-outbox.ts',import.meta.url).href;
function run(source){execFileSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',`import assert from'node:assert/strict';import{BrowserOutbox,OutboxRetryScheduler}from ${JSON.stringify(moduleUrl)};${source}`]);}
test('newer fallback terminal state wins over stale IndexedDB sent state',()=>run(`
 const storage=new Map();globalThis.localStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)};
 const base={clientMessageId:'m',sessionId:'s',text:'secret',attachments:[],planMode:'direct',createdAt:1,attempts:1};
 storage.set('agentdeck:outbox:fallback',JSON.stringify([{...base,status:'failed',updatedAt:20}]));
 const outbox=new BrowserOutbox();outbox.openDb=async()=>({transaction:()=>({objectStore:()=>({getAll(){const req={};queueMicrotask(()=>{req.result=[{...base,status:'sent',updatedAt:10}];req.onsuccess?.();});return req;}})}),close(){}});
 assert.equal((await outbox.list())[0].status,'failed');
`));
test('accepted and persisted clear body while failed and max-attempt records stay terminal',()=>run(`
 const storage=new Map();globalThis.localStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)};globalThis.indexedDB=undefined;
 const outbox=new BrowserOutbox(),base={sessionId:'s',text:'secret',attachments:[],planMode:'direct',createdAt:1,attempts:1};
 await outbox.put({...base,clientMessageId:'a',status:'sent'});await outbox.update('a',{status:'accepted'});assert.equal((await outbox.list())[0].text,'');
 await outbox.put({...base,clientMessageId:'p',status:'persisted'});await outbox.put({...base,clientMessageId:'f',status:'failed'});await outbox.put({...base,clientMessageId:'max',status:'sent',attempts:8});
 const rows=await outbox.list();assert.equal(rows.find(r=>r.clientMessageId==='p').text,'');assert.equal(rows.find(r=>r.clientMessageId==='f').status,'failed');assert.equal(rows.find(r=>r.clientMessageId==='max').status,'failed');
`));
test('concurrent wake sources create one timer and deadline recovery fires once',()=>run(`
 let now=0,next=1;const timers=new Map();const clock={now:()=>now,setTimeout:(fn,ms)=>{const id=next++;timers.set(id,{fn,at:now+ms});return id;},clearTimeout:id=>timers.delete(id)};
 const record={clientMessageId:'m',sessionId:'s',text:'x',attachments:[],planMode:'direct',createdAt:0,updatedAt:1,attempts:1,status:'sent',nextAttemptAt:100};let recoveries=0;
 const scheduler=new OutboxRetryScheduler(async()=>{await Promise.resolve();return[record];},async()=>{recoveries++;record.status='failed';},clock);
 await Promise.all([scheduler.wake(),scheduler.wake(),scheduler.wake()]);assert.equal(timers.size,1);now=100;for(const [id,{fn,at}]of[...timers])if(at<=now){timers.delete(id);fn();}await new Promise(r=>setTimeout(r,0));assert.equal(recoveries,1);assert.equal(timers.size,0);scheduler.stop();
`));
test('localStorage quota failure does not break the send path when IndexedDB is unavailable',()=>run(`
 globalThis.indexedDB=undefined;globalThis.localStorage={getItem:()=>null,setItem:()=>{throw new DOMException('quota','QuotaExceededError')}};
 const outbox=new BrowserOutbox();await assert.doesNotReject(outbox.put({clientMessageId:'m',sessionId:'s',text:'x',attachments:[],planMode:'direct',createdAt:1,attempts:1,status:'ready'}));
`));
test('a failed record can be manually returned to the retry queue',()=>run(`
 const storage=new Map();globalThis.indexedDB=undefined;globalThis.localStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)};
 const outbox=new BrowserOutbox();await outbox.put({clientMessageId:'m',sessionId:'s',text:'retry me',attachments:[],planMode:'direct',createdAt:1,attempts:3,status:'failed'});await outbox.update('m',{status:'ready',attempts:4,lastError:undefined,nextAttemptAt:2});const row=(await outbox.list())[0];assert.equal(row.status,'ready');assert.equal(row.text,'retry me');assert.equal(row.attempts,4);
`));
