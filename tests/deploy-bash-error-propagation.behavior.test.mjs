import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync,mkdtempSync,mkdirSync,readFileSync,readlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

const repo=new URL('..',import.meta.url).pathname;
const ctl=readFileSync(new URL('../scripts/agentdeckctl',import.meta.url),'utf8');

for(const [step,code] of [['npm-ci',31],['unit',32],['e2e',33]])test(`real make_release propagates ${step} failure and cleans its worktree`,()=>{
  const root=mkdtempSync(join(tmpdir(),'agentdeck-real-release-failure-')),source=join(root,'source'),control=join(root,'control'),data=join(root,'data');mkdirSync(source,{recursive:true});mkdirSync(data,{recursive:true});
  const script=`git -C "$SOURCE" init -q;git -C "$SOURCE" config user.email test@example.com;git -C "$SOURCE" config user.name test;echo base > "$SOURCE/file";git -C "$SOURCE" add file;git -C "$SOURCE" commit -qm base
source "$REPO/scripts/agentdeckctl";SOURCE_ROOT="$SOURCE";SERVICE_USER=$(id -un);SERVICE_HOME=$HOME
ensure_service_owned_dirs(){ :; };ensure_playwright_browsers(){ :; };verify_runtime_systemd_contract(){ :; };undrain_runtime(){ :; }
node(){ if [[ "${'${2:-}'}" = */deploy-manifest.json ]];then echo manifest >> "$ROOT/manifest-attempts";fi;command node "$@"; }
run_as_service_user(){
  if [ "$1" = git ];then shift;command git "$@";return $?;fi
  if [ "$1" = npm ];then
    if [ "$FAIL_STEP" = npm-ci ]&&[ "${'${2:-}'}" = ci ];then return 31;fi
    if [ "$FAIL_STEP" = unit ]&&[ "${'${2:-}'}" = test ];then return 32;fi
    if [ "$FAIL_STEP" = e2e ]&&[ "${'${2:-}'}" = run ]&&[ "${'${3:-}'}" = test:e2e ];then return 33;fi
    [ "${'${2:-}'}" = --version ]&&echo 10.0.0
    return 0
  fi
  if [ "$1" = node ]&&[ "${'${2:-}'}" = --version ];then echo v22.0.0;return 0;fi
  return 0
}
systemctl(){ echo restart >> "$ROOT/restarts"; }
ensure_dirs;mkdir -p "$RELEASES_DIR/old" "$RELEASES_DIR/prev";ln -s releases/old "$CURRENT_RUNTIME_LINK";ln -s releases/prev "$PREVIOUS_RUNTIME_LINK";write_job test accepted accepted;worker_deploy test runtime 0`;
  const run=spawnSync('bash',['-c',script],{encoding:'utf8',env:{...process.env,REPO:repo,SOURCE:source,ROOT:root,FAIL_STEP:step,AGENTDECK_FULL_VERIFY:'1',AGENTDECK_ROOT:control,AGENTDECK_SOURCE_ROOT:repo,AGENTDECK_DEPLOY_STATE_DIR:join(control,'state'),DATA_DIR:data}});
  try{
    assert.equal(run.status,code,run.stderr);const journal=readFileSync(join(control,'state/test.stages'),'utf8');const releaseId=journal.match(/^release_id=(.+)$/m)?.[1];assert.ok(releaseId);
    assert.equal(existsSync(join(control,'releases',releaseId)),false);assert.equal(existsSync(join(root,'manifest-attempts')),false);assert.equal(existsSync(join(root,'restarts')),false);
    assert.equal(readlinkSync(join(control,'current-runtime')),'releases/old');assert.match(journal,/release_cleanup_completed=1/);
    assert.doesNotMatch(spawnSync('git',['-C',source,'worktree','list','--porcelain'],{encoding:'utf8'}).stdout,new RegExp(releaseId));
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('deploy safety helpers explicitly propagate critical command failures',()=>{
  const block=(start,end)=>ctl.slice(ctl.indexOf(`${start}() {`),ctl.indexOf(`${end}() {`,ctl.indexOf(`${start}() {`)));
  const make=block('make_release','assert_release_unit_requirement');
  for(const command of ['ensure_dirs','ensure_service_owned_dirs','require_git_source_root','rev-parse HEAD','worktree add --detach','ensure_playwright_browsers','npm ci','npm run typecheck','npm run lint','npm run build','npm test','npm run test:e2e','node --version','npm --version','deploy-manifest.json','CANDIDATE_LINK.tmp'])assert.match(make,new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'[^\\n]*\\|\\| return \\$\\?'),command);
  const switching=block('switch_component','snapshot_deploy_pointers');
  assert.equal((switching.match(/\|\| return \$\?/g)||[]).length>=5,true);
  for(const name of ['snapshot_deploy_pointers','restore_component_pointer_snapshot','cleanup_release_worktree','deploy_recover_once','recover_incomplete_deploy_journals'])assert.match(ctl,new RegExp(`${name}\\(\\) \\{[\\s\\S]*?\\|\\| return \\$\\?`),name);
});

test('production release defaults to fast verification while retaining an explicit full mode',()=>{
  const make=ctl.slice(ctl.indexOf('make_release() {'),ctl.indexOf('assert_release_unit_requirement() {'));
  assert.match(make,/AGENTDECK_FULL_VERIFY:-0/);
  assert.match(make,/using production fast verification/);
  assert.match(make,/npm run build[^\n]*\|\| return \$\?/);
});
