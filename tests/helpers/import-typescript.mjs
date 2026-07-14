import { readFile } from 'node:fs/promises';
import ts from 'typescript';

export async function importTypeScript(url){
  const source=await readFile(url,'utf8');
  const {outputText}=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,verbatimModuleSyntax:true}});
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
}
