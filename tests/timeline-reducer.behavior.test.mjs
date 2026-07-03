import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

function runReducerScenario(source) {
  const script = `
    import assert from 'node:assert/strict';
    import {
      applyTimelineMessage,
      applyTimelineSnapshot,
      emptyTimelineState,
      resolveTurnUiStatus,
    } from ${JSON.stringify(new URL('../client/src/timeline-reducer.ts', import.meta.url).href)};
    const progress = {key:'progress', role:'assistant', text:'progress'};
    const final = {key:'final', role:'assistant', text:'final'};
    const msg = (sequence, id = 'm'+sequence) => ({type:'codex', method:'item/completed', runtimeSequence:sequence, runtimeGeneration:'g1', params:{item:{id, type:'agentMessage', text:id, phase:id==='final'?'final_answer':'commentary'}}});
    ${source}
  `;
  execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { stdio:'pipe' });
}

test('complete snapshot drops old replay and keeps final after progress', () => {
  runReducerScenario(`
    let state = emptyTimelineState(245);
    state = applyTimelineSnapshot(state, [progress, final], 3189);
    for (let sequence = 245; sequence <= 3189; sequence++) state = applyTimelineMessage(state, msg(sequence));
    assert.equal(state.liveMessages.length, 0);
    assert.deepEqual(state.snapshotEvents.map(e => e.key), ['progress','final']);
    assert.equal(state.appliedSequence, 3189);
  `);
});
test('replay before snapshot is cleaned when authoritative snapshot arrives', () => {
  runReducerScenario(`
    let state = emptyTimelineState(245);
    state = applyTimelineMessage(state, msg(246, 'old-progress'));
    assert.equal(state.liveMessages.length, 1);
    state = applyTimelineSnapshot(state, [progress, final], 3189);
    assert.equal(state.liveMessages.length, 0);
    assert.deepEqual(state.snapshotEvents.map(e => e.key), ['progress','final']);
  `);
});

test('snapshot before replay rejects all covered replay messages', () => {
  runReducerScenario(`
    let state = applyTimelineSnapshot(emptyTimelineState(0), [progress, final], 3189);
    state = applyTimelineMessage(state, msg(1245, 'covered'));
    state = applyTimelineMessage(state, msg(3189, 'covered-final'));
    state = applyTimelineMessage(state, msg(3190, 'new-live'));
    assert.deepEqual(state.liveMessages.map(m => m.runtimeSequence), [3190]);
  `);
});

test('overlapping replay pages advance by actual sequence without duplicates', () => {
  runReducerScenario(`
    let state = emptyTimelineState(244);
    const pages = [
      Array.from({length:1001}, (_,i) => 245 + i),
      Array.from({length:1001}, (_,i) => 1245 + i),
      Array.from({length:994}, (_,i) => 2196 + i),
    ];
    for (const page of pages) for (const sequence of page) state = applyTimelineMessage(state, msg(sequence));
    const sequences = state.liveMessages.map(m => m.runtimeSequence);
    assert.equal(sequences[0], 245);
    assert.equal(sequences.at(-1), 3189);
    assert.equal(new Set(sequences).size, sequences.length);
    assert.equal(sequences.length, 2945);
  `);
});

test('duplicate websocket event is idempotent', () => {
  runReducerScenario(`
    let state = emptyTimelineState(0);
    const event = {...msg(10), eventId:'evt-10'};
    state = applyTimelineMessage(state, event);
    state = applyTimelineMessage(state, event);
    assert.equal(state.liveMessages.length, 1);
  `);
});

test('active turn status beats active session status and waiting states have priority', () => {
  runReducerScenario(`
    assert.equal(resolveTurnUiStatus({status:'active', activeTurn:{turnId:'t1', status:'running'}}, [], false), 'running');
    assert.equal(resolveTurnUiStatus({status:'active'}, [], false), 'idle');
    assert.equal(resolveTurnUiStatus({status:'active', activeTurn:{turnId:'t1', status:'waiting_approval', waitingKind:'approval'}}, [], false), 'waiting_approval');
    assert.equal(resolveTurnUiStatus({status:'active', activeTurn:{turnId:'t1', status:'waiting_input', waitingKind:'input'}}, [], false), 'waiting_input');
    assert.equal(resolveTurnUiStatus({status:'running', activeTurn:{turnId:'t1', status:'running'}}, [], true), 'cancelling');
    assert.equal(resolveTurnUiStatus({status:'idle'}, [], false), 'idle');
  `);
});
