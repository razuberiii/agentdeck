import assert from'node:assert/strict';
import test from'node:test';
import{mkdtemp,mkdir,readFile,rm,symlink,utimes,writeFile}from'node:fs/promises';
import os from'node:os';
import path from'node:path';
import{artifactContentChanged,buildArtifactManifest,isArtifactTestAssetPath}from'../server/dist/artifact-manifest.js';

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
