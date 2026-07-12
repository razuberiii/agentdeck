import assert from 'node:assert/strict';
import {chmodSync,existsSync,mkdtempSync,mkdirSync,readlinkSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';

const repo=new URL('..',import.meta.url).pathname;
function verify({version=2,timeout=7201000000,fragment='/etc/systemd/system/agentdeck-runtime.service',dropins=''}={}){
  const root=mkdtempSync(join(tmpdir(),'agentdeck-systemd-contract-'));
  const run=spawnSync('bash',['-c','source "$REPO/scripts/agentdeckctl"; systemctl(){ printf "%s" "$CONTRACT"; }; verify_runtime_systemd_contract 2'],{encoding:'utf8',env:{...process.env,REPO:repo,AGENTDECK_ROOT:root,AGENTDECK_SOURCE_ROOT:repo,DATA_DIR:join(root,'data'),CONTRACT:`FragmentPath=${fragment}\nDropInPaths=${dropins}\nTimeoutStopUSec=${timeout}\nEnvironment=HOME=/tmp AGENTDECK_SYSTEMD_UNIT_VERSION=${version}\n`}});
  rmSync(root,{recursive:true,force:true});return run;
}

test('new agentdeckctl rejects an actually loaded old unit contract',()=>assert.notEqual(verify({version:1}).status,0));
test('/run drop-in effective timeout and contract pass validation',()=>{const result=verify({dropins:'/run/systemd/system/agentdeck-runtime.service.d/90-agentdeck-contract.conf'});assert.equal(result.status,0,result.stderr);});
test('drop-in on disk but absent from systemctl state is rejected as not daemon-reloaded',()=>assert.notEqual(verify({version:'',dropins:''}).status,0));

test('contract rejection occurs before build and leaves production pointer and PID untouched',()=>{
  const root=mkdtempSync(join(tmpdir(),'agentdeck-contract-block-')),data=join(root,'data'),bin=join(root,'bin');mkdirSync(data,{recursive:true});mkdirSync(bin);mkdirSync(join(root,'releases/old'),{recursive:true});
  writeFileSync(join(bin,'systemctl'),'#!/usr/bin/env bash\nif [ "$1" = show ];then printf "FragmentPath=/old/unit\\nDropInPaths=\\nTimeoutStopUSec=1\\nEnvironment=AGENTDECK_SYSTEMD_UNIT_VERSION=1\\n";else echo restart >> "$ROOT/restarts";fi\n');chmodSync(join(bin,'systemctl'),0o755);
  const script='source "$REPO/scripts/agentdeckctl";ensure_dirs;ln -s releases/old "$CURRENT_RUNTIME_LINK";make_release(){ echo built > "$ROOT/built"; };undrain_runtime(){ :; };write_job test accepted accepted;worker_deploy test runtime 0';
  const run=spawnSync('bash',['-c',script],{encoding:'utf8',env:{...process.env,REPO:repo,ROOT:root,AGENTDECK_ROOT:root,AGENTDECK_SOURCE_ROOT:repo,AGENTDECK_DEPLOY_STATE_DIR:join(root,'state'),DATA_DIR:data,PATH:`${bin}:${process.env.PATH}`}});
  try{assert.notEqual(run.status,0);assert.equal(readlinkSync(join(root,'current-runtime')),'releases/old');assert.equal(existsSync(join(root,'built')),false);assert.equal(existsSync(join(root,'restarts')),false);}finally{rmSync(root,{recursive:true,force:true});}
});
