import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

function scenario(source) {
  execFileSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',`
    import assert from 'node:assert/strict';
    import { DurableEventStore } from ${JSON.stringify(new URL('../server/dist/event-store.js',import.meta.url).href)};
    class FakeDb {
      rows=[]; last=0; fail=false; batches=0;
      async get(){ return {sequence:this.last}; }
      transactionRun(statements){ if(this.fail) throw new Error('sqlite failed'); this.batches++; for(let i=0;i<statements.length;i+=2){ const p=statements[i].params; this.rows.push({sequence:p[4],type:p[2]}); this.last=p[4]; } }
    }
    ${source}
  `],{stdio:'pipe'});
}

test('delta batches commit before ordered publication',()=>scenario(`
  const db=new FakeDb(); const published=[];
  const store=new DurableEventStore(db,'g1',{windowMs:20,onCommitted:event=>published.push(event.sequence)});
  const pending=[]; for(let i=0;i<100;i++) pending.push(store.append('s','item/agentMessage/delta',{delta:'x'},null,false,true));
  await Promise.all(pending); await store.drain();
  assert.equal(db.batches<100,true); assert.deepEqual(published,Array.from({length:100},(_,i)=>i+1));
  assert.equal(store.metrics.deltaQueueEventCount,0);
`));

test('failed durable append is never published and does not advance database sequence',()=>scenario(`
  const db=new FakeDb(); db.fail=true; const published=[];
  const store=new DurableEventStore(db,'g1',{onCommitted:event=>published.push(event.sequence)});
  await assert.rejects(store.append('s','turn/completed',{},null,true,false),/sqlite failed/);
  assert.equal(db.last,0); assert.deepEqual(published,[]);
`));

test('SSE replay barrier releases replay then buffered live events in order',()=>{
  execFileSync(process.execPath,['--input-type=module','-e',`
    import assert from 'node:assert/strict'; import {EventEmitter} from 'node:events';
    import {EventSubscriptions} from ${JSON.stringify(new URL('../server/dist/event-subscriptions.js',import.meta.url).href)};
    class Raw extends EventEmitter { destroyed=false; output=''; write(chunk){this.output+=chunk; return true;} destroy(){this.destroyed=true;this.emit('close');} off(...a){return super.off(...a);} }
    const raw=new Raw(); const subscriptions=new EventSubscriptions({maxBuffer:10});
    const event=n=>({session_id:'s',threadId:'s',generation:'g',sequence:n,event_type:'x',payload_json:'{}',created_at:n});
    await subscriptions.subscribe('s',raw,0,async()=>3,async()=>{subscriptions.publish(event(4)); return [event(1),event(2),event(3)];});
    const sequences=[...raw.output.matchAll(/"sequence":(\\d+)/g)].map(match=>Number(match[1]));
    assert.deepEqual(sequences,[1,2,3,4]);
  `],{stdio:'pipe'});
});

test('event committed while durable watermark is read is not lost',()=>{
  execFileSync(process.execPath,['--input-type=module','-e',`
    import assert from 'node:assert/strict'; import {EventEmitter} from 'node:events';
    import {EventSubscriptions} from ${JSON.stringify(new URL('../server/dist/event-subscriptions.js',import.meta.url).href)};
    class Raw extends EventEmitter { destroyed=false; output=''; write(chunk){this.output+=chunk; return true;} destroy(){this.destroyed=true;this.emit('close');} off(...a){return super.off(...a);} }
    const raw=new Raw(), subscriptions=new EventSubscriptions();
    const event=n=>({session_id:'s',threadId:'s',generation:'g',sequence:n,event_type:'x',payload_json:'{}',created_at:n});
    await subscriptions.subscribe('s',raw,0,async()=>{ subscriptions.publish(event(1)); return 1; },async()=>[event(1)]);
    const sequences=[...raw.output.matchAll(/"sequence":(\\d+)/g)].map(m=>Number(m[1]));
    assert.deepEqual(sequences,[1]);
  `]);
});
