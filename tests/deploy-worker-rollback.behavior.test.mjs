import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {chmodSync,mkdtempSync,mkdirSync,readFileSync,readlinkSync,rmSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

const repo=new URL('..',import.meta.url).pathname;
const releaseId='20260711-120000-abcdef123456';

function scenario(target,failAt,keepReference=false){
  const root=mkdtempSync(join(tmpdir(),'agentdeck-worker-rollback-')),data=join(root,'data'),bin=join(root,'bin');
  mkdirSync(bin,{recursive:true});mkdirSync(data,{recursive:true});writeFileSync(join(root,'systemctl.log'),'');
  const script=`
    source "$REPO/scripts/agentdeckctl"
    ensure_dirs
    for r in old-web old-runtime old-prev-web old-prev-runtime; do mkdir -p "$RELEASES_DIR/$r"; done
    ln -s releases/old-web "$CURRENT_WEB_LINK"; ln -s releases/old-prev-web "$PREVIOUS_WEB_LINK"
    ln -s releases/old-runtime "$CURRENT_RUNTIME_LINK"; ln -s releases/old-prev-runtime "$PREVIOUS_RUNTIME_LINK"
    make_release(){ mkdir -p "$RELEASES_DIR/${releaseId}"; CREATED_RELEASE_ID=${releaseId}; }
    verify_runtime_systemd_contract(){ :; }; assert_release_unit_requirement(){ :; }; check_systemd_units(){ :; }; start_candidate_runtime(){ :; }; start_candidate_web(){ :; }; validate_candidate_runtime_compatibility(){ :; }
    drain_runtime(){ :; }; undrain_runtime(){ :; }; wait_drain(){ :; }; require_runtime_drained(){ :; }; cleanup_releases(){ :; }
    systemctl(){ echo "$*" >> "$SYSTEMCTL_LOG"; }
    echo 0 > "$ROOT/wait-calls"
    wait_http(){ local calls; calls=$(cat "$ROOT/wait-calls"); calls=$((calls+1)); echo "$calls" > "$ROOT/wait-calls"; [ "$calls" -ne "$FAIL_AT" ]; }
    write_job test accepted accepted
    ${keepReference ? `AGENTDECK_JOB_RELEASE=${releaseId} write_job keeper running keep` : ':'}
    worker_deploy test "$TARGET" 0
  `;
  const child=spawnSync('bash',['-c',script],{encoding:'utf8',env:{...process.env,REPO:repo,ROOT:root,AGENTDECK_ROOT:root,AGENTDECK_SOURCE_ROOT:repo,AGENTDECK_DEPLOY_STATE_DIR:join(root,'state'),DATA_DIR:data,PATH:`${bin}:${process.env.PATH}`,SYSTEMCTL_LOG:join(root,'systemctl.log'),TARGET:target,FAIL_AT:String(failAt)}});assert.notEqual(child.status,0,child.stderr);
  return {root,links:{web:readlinkSync(join(root,'current-web')),previousWeb:readlinkSync(join(root,'previous-web')),runtime:readlinkSync(join(root,'current-runtime')),previousRuntime:readlinkSync(join(root,'previous-runtime'))},systemctl:readFileSync(join(root,'systemctl.log'),'utf8'),job:JSON.parse(readFileSync(join(root,'state/jobs/test.json'),'utf8')),releaseExists:existsSync(join(root,'releases',releaseId))};
}

for(const [name,target,failAt] of [['runtime cutover health failure','runtime',1],['all cutover web health failure','all',2]])test(name,()=>{
  const result=scenario(target,failAt);try{
    assert.deepEqual(result.links,{web:'releases/old-web',previousWeb:'releases/old-prev-web',runtime:'releases/old-runtime',previousRuntime:'releases/old-prev-runtime'});
    assert.match(result.systemctl,/restart agentdeck-runtime\.service/);if(target==='all')assert.match(result.systemctl,/restart agentdeck-web\.service/);
    assert.equal(result.job.status,'failed');assert.match(result.job.message,/started operations recovered/);assert.equal(result.releaseExists,false);
  }finally{rmSync(result.root,{recursive:true,force:true});}
});

test('failed release referenced by another running job is retained',()=>{const result=scenario('runtime',1,true);try{assert.equal(result.releaseExists,true);}finally{rmSync(result.root,{recursive:true,force:true});}});

for(const failure of ['npm ci','unit test','E2E','candidate health'])test(`${failure} failure leaves production pointers and PIDs untouched`,()=>{
  const root=mkdtempSync(join(tmpdir(),'agentdeck-pre-cutover-')),data=join(root,'data');mkdirSync(data,{recursive:true});writeFileSync(join(root,'systemctl.log'),'');
  const candidateFailure=failure==='candidate health';
  const script=`source "$REPO/scripts/agentdeckctl";ensure_dirs;for r in old-web old-runtime;do mkdir -p "$RELEASES_DIR/$r";done;ln -s releases/old-web "$CURRENT_WEB_LINK";ln -s releases/old-runtime "$CURRENT_RUNTIME_LINK";verify_runtime_systemd_contract(){ :; };make_release(){ ${candidateFailure?`mkdir -p "$RELEASES_DIR/${releaseId}";CREATED_RELEASE_ID=${releaseId}`:'return 23'}; };assert_release_unit_requirement(){ :; };check_systemd_units(){ :; };start_candidate_runtime(){ ${candidateFailure?'return 24':':'}; };start_candidate_web(){ :; };systemctl(){ echo "$*" >> "$SYSTEMCTL_LOG"; };undrain_runtime(){ :; };write_job test accepted accepted;worker_deploy test all 0`;
  const child=spawnSync('bash',['-c',script],{encoding:'utf8',env:{...process.env,REPO:repo,ROOT:root,AGENTDECK_ROOT:root,AGENTDECK_SOURCE_ROOT:repo,AGENTDECK_DEPLOY_STATE_DIR:join(root,'state'),DATA_DIR:data,SYSTEMCTL_LOG:join(root,'systemctl.log')}});
  try{assert.notEqual(child.status,0);assert.equal(readlinkSync(join(root,'current-web')),'releases/old-web');assert.equal(readlinkSync(join(root,'current-runtime')),'releases/old-runtime');assert.equal(readFileSync(join(root,'systemctl.log'),'utf8'),'');}finally{rmSync(root,{recursive:true,force:true});}
});

test('recovery failure preserves original exit and stage diagnostics',()=>{
  const root=mkdtempSync(join(tmpdir(),'agentdeck-recovery-diagnostic-')),data=join(root,'data');mkdirSync(data,{recursive:true});
  const script=`source "$REPO/scripts/agentdeckctl";ensure_dirs;for r in old-runtime old-prev;do mkdir -p "$RELEASES_DIR/$r";done;ln -s releases/old-runtime "$CURRENT_RUNTIME_LINK";ln -s releases/old-prev "$PREVIOUS_RUNTIME_LINK";verify_runtime_systemd_contract(){ :; };make_release(){ mkdir -p "$RELEASES_DIR/${releaseId}";CREATED_RELEASE_ID=${releaseId}; };assert_release_unit_requirement(){ :; };check_systemd_units(){ :; };start_candidate_runtime(){ :; };validate_candidate_runtime_compatibility(){ :; };drain_runtime(){ :; };undrain_runtime(){ :; };wait_drain(){ :; };require_runtime_drained(){ :; };switches=0;systemctl(){ switches=$((switches+1));[ "$switches" = 1 ]; };wait_http(){ return 31; };write_job test accepted accepted;worker_deploy test runtime 0`;
  const child=spawnSync('bash',['-c',script],{encoding:'utf8',env:{...process.env,REPO:repo,ROOT:root,AGENTDECK_ROOT:root,AGENTDECK_SOURCE_ROOT:repo,AGENTDECK_DEPLOY_STATE_DIR:join(root,'state'),DATA_DIR:data}});
  try{assert.equal(child.status,70);const job=JSON.parse(readFileSync(join(root,'state/jobs/test.json'),'utf8'));assert.match(job.message,/deploy failed \(exit 31\).*recovery failed/);assert.match(readFileSync(join(root,'state/test.stages'),'utf8'),/original_exit_code=31/);}finally{rmSync(root,{recursive:true,force:true});}
});

function crashScenario(mode){
  const root=mkdtempSync(join(tmpdir(),'agentdeck-crash-journal-')),data=join(root,'data');mkdirSync(data,{recursive:true});
  const script=`source "$REPO/scripts/agentdeckctl";ensure_dirs
for r in old-runtime old-prev-runtime;do mkdir -p "$RELEASES_DIR/$r";done
ln -s releases/old-runtime "$CURRENT_RUNTIME_LINK";ln -s releases/old-prev-runtime "$PREVIOUS_RUNTIME_LINK"
make_release(){ mkdir -p "$RELEASES_DIR/${releaseId}";CREATED_RELEASE_ID=${releaseId}; }
verify_runtime_systemd_contract(){ :; };assert_release_unit_requirement(){ :; };check_systemd_units(){ :; };start_candidate_runtime(){ :; };validate_candidate_runtime_compatibility(){ :; }
drain_runtime(){ :; };undrain_runtime(){ :; };wait_drain(){ :; };require_runtime_drained(){ :; };wait_http(){ :; };cleanup_releases(){ :; }
original_stage='';eval "$(declare -f deploy_stage_set | sed '1s/deploy_stage_set/original_stage_set/')"
deploy_stage_set(){
  if [ "$MODE" = completed-gap ] && [ "$2" = runtime_pointer_switch_completed ];then exit 42;fi
  if [ "$MODE" = term ] && [ "$2" = runtime_pointer_switch_completed ];then kill -TERM $$;fi
  original_stage_set "$@"
}
mv_failed=0
mv(){
  if [ "$MODE" = partial-pointer ] && [ "$mv_failed" = 0 ] && [ "${'${!#}'}" = "$CURRENT_RUNTIME_LINK" ];then mv_failed=1;return 41;fi
  command mv "$@"
}
restart_calls=0
systemctl(){
  restart_calls=$((restart_calls+1));echo "$restart_calls:$*" >> "$ROOT/systemctl.log"
  if [ "$restart_calls" = 1 ] && { [ "$MODE" = restart-side-effect ] || [ "$MODE" = restart-not-applied ]; };then
    [ "$MODE" = restart-side-effect ] && echo side-effect >> "$ROOT/restart-effects"
    return 43
  fi
}
write_job test accepted accepted;worker_deploy test runtime 0`;
  const child=spawnSync('bash',['-c',script],{encoding:'utf8',env:{...process.env,REPO:repo,ROOT:root,MODE:mode,AGENTDECK_ROOT:root,AGENTDECK_SOURCE_ROOT:repo,AGENTDECK_DEPLOY_STATE_DIR:join(root,'state'),DATA_DIR:data}});
  return {root,child,current:readlinkSync(join(root,'current-runtime')),previous:readlinkSync(join(root,'previous-runtime')),journal:readFileSync(join(root,'state/test.stages'),'utf8'),systemctl:existsSync(join(root,'systemctl.log'))?readFileSync(join(root,'systemctl.log'),'utf8'):''};
}

for(const [mode,name] of [
  ['partial-pointer','previous pointer changed before current pointer write fails'],
  ['completed-gap','pointer switched before completed journal write'],
  ['restart-side-effect','restart has a side effect but returns non-zero'],
  ['term','TERM after pointer switch'],
  ['restart-not-applied','restart started although the first restart did not happen'],
])test(name,()=>{const result=crashScenario(mode);try{
  assert.notEqual(result.child.status,0,result.child.stderr);assert.equal(result.current,'releases/old-runtime');assert.equal(result.previous,'releases/old-prev-runtime');
  assert.match(result.journal,/runtime_pointer_switch_started=1/);assert.match(result.journal,/recovery_completed=1/);
  if(mode.startsWith('restart-'))assert.equal((result.systemctl.match(/restart agentdeck-runtime\.service/g)||[]).length,2);
}finally{rmSync(result.root,{recursive:true,force:true});}});
