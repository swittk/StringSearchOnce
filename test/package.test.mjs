import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

test('packed artifact works outside the checkout, with ESM/CJS workers and declarations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stringsearchonce-consumer-'));
  const run = (file, args, cwd = dir) => execFileSync(file, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const [packed] = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', dir], root));
    assert(packed.files.some(file => file.path === 'dist/stringSearchBuilderWorker.js'));
    assert(packed.files.every(file => file.path.startsWith('dist/') || ['package.json','README.md','LICENSE'].includes(file.path)));
    writeFileSync(join(dir,'package.json'), '{"name":"consumer-test","private":true,"type":"module"}');
    run('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', join(dir,packed.filename)]);
    const body = `
const rows = [{id:'01', names:[{kind:'title',text:'Blue desk'}]}];
const built = await buildPostingGenerationInWorker(rows,{generation:'test',kinds:['title']});
const reader = new PostingReader(built.manifest,{
  async readPages(_generation,kind,pages) {
    return new Map(pages.map(page=>[page,built.pages.get(kind)[page]]));
  }
});
const result = await reader.search({
  text:'desk',fetchSources:async()=>rows,getId:row=>row.id,getNames:row=>row.names,
});
if (result.results[0]?.object.id !== '01') throw Error('Bad consumer result');
`;
    writeFileSync(join(dir,'esm.mjs'), `import {buildPostingGenerationInWorker,PostingReader} from 'stringsearchonce';
` + body);
    writeFileSync(join(dir,'cjs.cjs'), `const {buildPostingGenerationInWorker,PostingReader}=require('stringsearchonce');
(async()=>{
${body}
})().catch(e=>{console.error(e);process.exitCode=1});`);
    run(process.execPath, ['esm.mjs']);
    run(process.execPath, ['cjs.cjs']);
    const typed = `
const rows: PostingDocument[] = [{id:'01',names:[{kind:'title',text:'Desk'}]}];
const built = buildPostingGeneration(rows,{generation:'test',kinds:['title']});
const store: PostingPageStore = {async readPages(_generation,kind,pages) {
  return new Map(pages.map(page=>[page,built.pages.get(kind)![page]!]));
}};
new PostingReader(built.manifest,store);
`;
    const imports = `import {buildPostingGeneration,PostingReader,type PostingDocument,type PostingPageStore} from 'stringsearchonce';
`;
    writeFileSync(join(dir,'typed.mts'), imports + typed);
    writeFileSync(join(dir,'typed.cts'), imports + typed);
    run(process.execPath, [resolve(root,'node_modules/typescript/bin/tsc'),'--noEmit','--strict','--module','NodeNext','--moduleResolution','NodeNext','--target','ES2022','--skipLibCheck','typed.mts','typed.cts']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
