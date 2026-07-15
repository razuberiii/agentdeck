import assert from'node:assert/strict';
import test from'node:test';
import{mkdtemp,mkdir,readFile,rm,symlink,utimes,writeFile}from'node:fs/promises';
import os from'node:os';
import path from'node:path';
import{artifactContentChanged,artifactEligibleForDownload,buildArtifactManifest,isArtifactTestAssetPath,workspaceCodeChanges,workspaceCodeChangesForDisplay}from'../server/dist/artifact-manifest.js';

const options=previous=>({types:{'.txt':'text/plain'},skipDirs:new Set(),isInternal:isArtifactTestAssetPath,previous});

test('test asset directories are excluded and metadata-only rewrites are not artifacts',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'agentdeck-artifacts-'));
  try{
  await mkdir(path.join(root,'client/public/test-assets'),{recursive:true});
  await mkdir(path.join(root,'server/public/test-assets/nested'),{recursive:true});
  await writeFile(path.join(root,'client/public/test-assets/a.txt'),'hidden');
  await writeFile(path.join(root,'server/public/test-assets/nested/b.txt'),'hidden');
  const file=path.join(root,'visible.txt');await writeFile(file,'same bytes');
  const before=await buildArtifactManifest(root,options());
  assert.deepEqual(Object.keys(before),['visible.txt']);
  const original=await readFile(file);await writeFile(file,original);await utimes(file,new Date(),new Date(Date.now()+2000));
  const after=await buildArtifactManifest(root,options(before));
  assert.equal(artifactContentChanged(before['visible.txt'],after['visible.txt']),false);
  await writeFile(file,'true change');
  const changed=await buildArtifactManifest(root,options(after));
  assert.equal(artifactContentChanged(after['visible.txt'],changed['visible.txt']),true);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('downloadable creations are excluded from code changes without hiding source, modify, delete, or rename',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'agentdeck-artifact-classify-'));
  try{
    await mkdir(path.join(root,'src'),{recursive:true});await mkdir(path.join(root,'reports'),{recursive:true});
    await writeFile(path.join(root,'package.json'),'{}\n');await writeFile(path.join(root,'reports/existing.json'),'{"old":true}\n');await writeFile(path.join(root,'src/rename-old.ts'),'same\n');
    for(let i=0;i<15;i++)await writeFile(path.join(root,'src',`existing-${i}.ts`),`export const n=${i};\n`);
    const all=previous=>({...options(previous),includeAll:true,maxFiles:100});const before=await buildArtifactManifest(root,all());
    for(let i=0;i<15;i++)await writeFile(path.join(root,'src',`existing-${i}.ts`),`export const n=${i+100};\n`);
    await writeFile(path.join(root,'package.json'),'{"changed":true}\n');await writeFile(path.join(root,'reports/existing.json'),'{"old":false}\n');await writeFile(path.join(root,'reports/result.json'),'{"result":true}\n');await writeFile(path.join(root,'image.png'),'png');await writeFile(path.join(root,'src/new.ts'),'export const fresh=true;\n');await rm(path.join(root,'src/rename-old.ts'));await writeFile(path.join(root,'src/rename-new.ts'),'same\n');
    const after=await buildArtifactManifest(root,all(before)),downloadable=new Set(['reports/result.json','image.png']),changes=workspaceCodeChangesForDisplay(before,after,downloadable);
    assert.equal(changes.some(change=>change.path==='reports/result.json'),false);assert.equal(changes.some(change=>change.path==='image.png'),false);assert.ok(changes.some(change=>change.status==='A'&&change.path==='src/new.ts'));assert.ok(changes.some(change=>change.status==='M'&&change.path==='package.json'));assert.ok(changes.some(change=>change.status==='M'&&change.path==='reports/existing.json'));assert.ok(changes.some(change=>change.status==='R'&&change.path==='src/rename-old.ts'&&change.toPath==='src/rename-new.ts'));assert.equal(changes.filter(change=>change.path.startsWith('src/existing-')).length,15);
    assert.equal(artifactEligibleForDownload('reports/result.json','created'),true);assert.equal(artifactEligibleForDownload('image.png','created'),true);assert.equal(artifactEligibleForDownload('reports/existing.json','modified'),false);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('download artifacts are distinct from final workspace code changes',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'agentdeck-workspace-changes-'));
  try{
    await mkdir(path.join(root,'src'),{recursive:true});
    await mkdir(path.join(root,'reports'),{recursive:true});
    const pkg=path.join(root,'package.json');
    await writeFile(pkg,'{"name":"baseline"}\n');
    await writeFile(path.join(root,'src/app.ts'),'export const value = 1;\n');
    const manifestOptions=previous=>({...options(previous),includeAll:true,maxFiles:100});
    const baseline=await buildArtifactManifest(root,manifestOptions());

    await writeFile(pkg,'{"name":"temporary"}\n');
    await writeFile(pkg,'{"name":"baseline"}\n');
    const restored=await buildArtifactManifest(root,manifestOptions(baseline));
    assert.deepEqual(workspaceCodeChanges(baseline,restored),[]);

    await writeFile(pkg,'{"name":"changed"}\n');
    await writeFile(path.join(root,'src/app.ts'),'export const value = 2;\n');
    const changed=await buildArtifactManifest(root,manifestOptions(restored));
    assert.deepEqual(workspaceCodeChanges(baseline,changed),[
      {status:'M',path:'package.json'},
      {status:'M',path:'src/app.ts'},
    ]);

    assert.equal(artifactEligibleForDownload('package.json','created'),false);
    assert.equal(artifactEligibleForDownload('package.json','modified'),false);
    assert.equal(artifactEligibleForDownload('src/app.ts','created'),false);
    assert.equal(artifactEligibleForDownload('reports/result.json','created'),true);
    assert.equal(artifactEligibleForDownload('reports/result.json','modified'),false);
    for(const name of['image.png','change.patch','table.csv','bundle.zip'])assert.equal(artifactEligibleForDownload(name,'created'),true);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('artifact manifest remains bounded and rejects symlink escapes',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'agentdeck-artifacts-bound-')),outside=await mkdtemp(path.join(os.tmpdir(),'agentdeck-artifacts-out-'));
  try{
    await writeFile(path.join(outside,'secret.txt'),'secret');
    await symlink(path.join(outside,'secret.txt'),path.join(root,'escape.txt'));
    for(let i=0;i<220;i++)await writeFile(path.join(root,`${String(i).padStart(3,'0')}.txt`),'x');
    const manifest=await buildArtifactManifest(root,options());
    assert.equal(Object.keys(manifest).length,200);
    assert.equal(manifest['escape.txt'],undefined);
  }finally{await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
});
