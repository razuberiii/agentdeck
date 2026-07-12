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
test('older fallback terminal state also wins over a newer lower IndexedDB state',()=>run(`
 const storage=new Map();globalThis.localStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)};
 const base={clientMessageId:'m',sessionId:'s',text:'secret',attachments:[],planMode:'direct',createdAt:1,attempts:1};storage.set('agentdeck:outbox:fallback',JSON.stringify([{...base,status:'failed',lastError:'boom',updatedAt:10}]));
 const outbox=new BrowserOutbox();outbox.openDb=async()=>({transaction:()=>({objectStore:()=>({getAll(){const req={};queueMicrotask(()=>{req.result=[{...base,status:'received',updatedAt:20}];req.onsuccess?.();});return req;}})}),close(){}});const row=(await outbox.list())[0];assert.equal(row.status,'failed');assert.equal(row.lastError,'boom');
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
test('localStorage quota failure is reported before an unpersisted message is sent',()=>run(`
 globalThis.indexedDB=undefined;globalThis.localStorage={getItem:()=>null,setItem:()=>{throw new DOMException('quota','QuotaExceededError')}};
 const outbox=new BrowserOutbox();assert.equal(await outbox.put({clientMessageId:'m',sessionId:'s',text:'x',attachments:[],planMode:'direct',createdAt:1,attempts:1,status:'ready'}),false);
`));
test('outbox subscribers observe receipt status changes immediately',()=>run(`
 const storage=new Map();globalThis.indexedDB=undefined;globalThis.localStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)};
 const outbox=new BrowserOutbox(),seen=[];const unsubscribe=outbox.subscribe(()=>seen.push('changed'));const base={clientMessageId:'m',sessionId:'s',text:'retry me',attachments:[],planMode:'direct',createdAt:1,attempts:1,status:'sent'};
 await outbox.put(base);for(const status of['received','persisted','accepted','failed'])await outbox.update('m',{status,lastError:status==='failed'?'boom':undefined});unsubscribe();await outbox.update('m',{status:'received'});
 assert.equal(seen.length,5);assert.equal((await outbox.list())[0].status,'failed');
`));
test('concurrent receipt updates cannot roll a message status backward',()=>run(`
 const storage=new Map();globalThis.indexedDB=undefined;globalThis.localStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)};
 const outbox=new BrowserOutbox(),base={clientMessageId:'m',sessionId:'s',text:'x',attachments:[],planMode:'direct',createdAt:1,attempts:1,status:'sent'};await outbox.put(base);
 const originalList=outbox.list.bind(outbox),gates=[];outbox.list=async(...args)=>{const rows=await originalList(...args);await new Promise(resolve=>gates.push(resolve));return rows;};
 const stale=outbox.update('m',{status:'received'}),terminal=outbox.update('m',{status:'failed',lastError:'boom'});while(gates.length<2)await new Promise(r=>setTimeout(r,0));gates[1]();await terminal;gates[0]();await stale;
 const row=(await originalList())[0];assert.equal(row.status,'failed');assert.equal(row.lastError,'boom');
`));
test('failed retry uses new lineage id and concurrent double click sends once',()=>run(`
 const storage=new Map();globalThis.indexedDB=undefined;globalThis.localStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)};
 const outbox=new BrowserOutbox(),original={clientMessageId:'old',sessionId:'s',text:'retry me',attachments:[],planMode:'direct',createdAt:1,attempts:3,status:'failed'},active=new Set();await outbox.put(original);let sends=0;
 async function retry(){if(active.has('old'))return;active.add('old');try{const record=(await outbox.list('s')).find(row=>row.clientMessageId==='old');if(record?.status!=='failed')return;const retry={...record,clientMessageId:'new',retryOf:'old',status:'ready',attempts:1,createdAt:2};await new Promise(r=>setTimeout(r,10));await outbox.put(retry);await outbox.update('old',{status:'cancelled'});sends++;await outbox.update('new',{status:'sent'});}finally{active.delete('old');}}
 await Promise.all([retry(),retry()]);await retry();const rows=await outbox.list('s');assert.equal(sends,1);assert.equal(rows.find(row=>row.clientMessageId==='new').retryOf,'old');assert.equal(rows.find(row=>row.clientMessageId==='old').status,'cancelled');
`));
