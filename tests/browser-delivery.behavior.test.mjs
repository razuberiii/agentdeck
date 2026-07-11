import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import test from 'node:test';
import {BrowserDeliveryHub} from '../server/dist/browser-delivery.js';

class Socket extends EventEmitter{
  readyState=1;sent=[];closed=false;
  send(text,done){this.sent.push(JSON.parse(text));queueMicrotask(()=>done?.());}
  close(){this.closed=true;this.readyState=3;}
}

test('snapshot to join window replays exactly once then shares live',async()=>{
  const hub=new BrowserDeliveryHub(),ws=new Socket();
  hub.publish('s',11,'g',[{type:'system',runtimeSequence:11,text:'window'}]);
  const replay=hub.beginReplay(ws,'s',{connectionGeneration:1,joinRequestId:'j',recoveryEpoch:0},10,11);
  assert.ok(replay);await hub.finishReplay(ws,'s',replay.state,replay.groups,{type:'joined'});
  hub.publish('s',12,'g',[{type:'system',runtimeSequence:12,text:'live'}]);await hub.state(ws,'s').sendChain;
  assert.deepEqual(ws.sent.map(frame=>frame.runtimeSequence||frame.type),[11,'joined',12]);
});

test('replay live handoff drains events produced during replay in strict order',async()=>{
  const hub=new BrowserDeliveryHub(),ws=new Socket();for(let n=515;n<=519;n++)hub.publish('s',n,'g',[{type:'system',runtimeSequence:n}]);
  const replay=hub.beginReplay(ws,'s',{connectionGeneration:1,joinRequestId:'j',recoveryEpoch:2},514,519);assert.ok(replay);
  const finishing=hub.finishReplay(ws,'s',replay.state,replay.groups,{type:'joined'});for(let n=520;n<=522;n++)hub.publish('s',n,'g',[{type:'system',runtimeSequence:n}]);await finishing;await hub.state(ws,'s').sendChain;
  assert.deepEqual(ws.sent.filter(frame=>frame.runtimeSequence).map(frame=>frame.runtimeSequence),[515,516,517,518,519,520,521,522]);assert.equal(ws.sent.at(-1).type,'joined');
});

test('ring coverage failure requires resnapshot and different browser cursors stay independent',async()=>{
  const hub=new BrowserDeliveryHub({maxSequences:3}),old=new Socket(),fresh=new Socket();for(let n=1;n<=5;n++)hub.publish('s',n,'g',[{type:'system',runtimeSequence:n}]);
  assert.equal(hub.beginReplay(old,'s',{connectionGeneration:1,joinRequestId:'old',recoveryEpoch:0},1,5),null);
  const replay=hub.beginReplay(fresh,'s',{connectionGeneration:2,joinRequestId:'fresh',recoveryEpoch:0},3,5);assert.ok(replay);await hub.finishReplay(fresh,'s',replay.state,replay.groups,{type:'joined'});assert.deepEqual(fresh.sent.filter(x=>x.runtimeSequence).map(x=>x.runtimeSequence),[4,5]);
});
