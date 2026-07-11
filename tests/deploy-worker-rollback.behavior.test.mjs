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
    assert_release_unit_requirement(){ :; }; check_systemd_units(){ :; }; start_candidate_runtime(){ :; }; start_candidate_web(){ :; }; validate_candidate_runtime_compatibility(){ :; }
    drain_runtime(){ :; }; undrain_runtime(){ :; }; wait_drain(){ :; }; cleanup_releases(){ :; }
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
    assert.equal(result.job.status,'failed');assert.match(result.job.message,/restored and healthy/);assert.equal(result.releaseExists,false);
  }finally{rmSync(result.root,{recursive:true,force:true});}
});

test('failed release referenced by another running job is retained',()=>{const result=scenario('runtime',1,true);try{assert.equal(result.releaseExists,true);}finally{rmSync(result.root,{recursive:true,force:true});}});
