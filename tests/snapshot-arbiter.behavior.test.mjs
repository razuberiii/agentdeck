import assert from 'node:assert/strict';
import test from 'node:test';
import { SnapshotArbiter } from '../client/src/snapshot-arbiter.ts';

test('same-session snapshots apply only in request order',()=>{
  const arbiter=new SnapshotArbiter(),a=arbiter.begin(1,10,'g1'),b=arbiter.begin(1,10,'g1');
  assert.equal(arbiter.accepts(b,{sessionGeneration:1,appliedSequence:10,runtimeGeneration:'g1'},{coveredSequence:20,runtimeGeneration:'g1'}),true);
  assert.equal(arbiter.accepts(a,{sessionGeneration:1,appliedSequence:20,runtimeGeneration:'g1'},{coveredSequence:15,runtimeGeneration:'g1'}),false);
});

test('snapshot started before websocket progress cannot roll it back',()=>{
  const arbiter=new SnapshotArbiter(),request=arbiter.begin(1,100,'g1');
  assert.equal(arbiter.accepts(request,{sessionGeneration:1,appliedSequence:105,runtimeGeneration:'g1'},{coveredSequence:100,runtimeGeneration:'g1'}),false);
});

test('latest authoritative snapshot can roll back a restored database generation',()=>{
  const arbiter=new SnapshotArbiter(),request=arbiter.begin(1,200,'g1');
  assert.equal(arbiter.accepts(request,{sessionGeneration:1,appliedSequence:205,runtimeGeneration:'g1'},{coveredSequence:150,runtimeGeneration:'g2'}),true);
});

test('generation-only websocket progress rejects an old HTTP snapshot',()=>{
  const arbiter=new SnapshotArbiter(),request=arbiter.begin(1,100,'g1');
  assert.equal(arbiter.accepts(request,{sessionGeneration:1,appliedSequence:100,runtimeGeneration:'g2'},{coveredSequence:100,runtimeGeneration:'g1'}),false);
  assert.equal(arbiter.accepts(request,{sessionGeneration:1,appliedSequence:100,runtimeGeneration:'g2'},{coveredSequence:90,runtimeGeneration:'g2'}),true);
});
