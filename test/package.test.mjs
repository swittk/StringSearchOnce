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
const search = {
  text:'desk',fetchSources:async()=>rows,getId:row=>row.id,getNames:row=>row.names,
};
const result = await reader.search(search);
if (result.results[0]?.object.id !== '01') throw Error('Bad consumer result');
for await (const ids of reader.idBatches()) {
  if (ids.length !== 1 || ids[0] !== '01') throw Error('Bad ID batch');
}
const page = await PostingReader.searchCompositePage([reader], {
  ...search, scopeKey:'catalog', signingKey:'example-server-signing-key',
});
if (page.results[0]?.object.id !== '01') throw Error('Bad composite result');
`;
    const esm = `import {buildPostingGenerationInWorker,PostingReader} from 'stringsearchonce';\n` + body;
    writeFileSync(join(dir,'esm.mjs'), esm);
    writeFileSync(join(dir,'cjs.cjs'), `const {buildPostingGenerationInWorker,PostingReader}=require('stringsearchonce');
(async()=>{
${body}
})().catch(e=>{console.error(e);process.exitCode=1});`);
    run(process.execPath, ['esm.mjs']);
    run(process.execPath, ['cjs.cjs']);
    execFileSync(process.execPath, ['--input-type=module', '--max-old-space-size=1024'], {
      cwd: dir, input: esm, stdio: ['pipe', 'pipe', 'pipe'],
    });
    run(process.execPath, ['--input_type', 'module', '--eval', esm]);
    execFileSync(process.execPath, [], {
      cwd: dir, env: { ...process.env, NODE_OPTIONS: '--input-type=module' },
      input: esm, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const typed = `
const rows: PostingDocument[] = [{id:'01',names:[{kind:'title',text:'Desk'}]}];
const built = buildPostingGeneration(rows,{generation:'test',kinds:['title']});
const store: PostingPageStore = {async readPages(_generation,kind,pages) {
  return new Map(pages.map(page=>[page,built.pages.get(kind)![page]!]));
}};
const reader = new PostingReader(built.manifest,store);
const batches: AsyncIterable<readonly string[]> = reader.idBatches();
const page: Promise<PostingCompositePageResult<PostingDocument>> = PostingReader.searchCompositePage([reader],{
  text:'desk',fetchSources:async()=>rows,getId:row=>row.id,getNames:row=>row.names,
  scopeKey:'catalog',signingKey:'example-server-signing-key',
  readLive:async(after,limit)=>after?.id === '01' || !limit ? [] : [{object:rows[0],stage:'exact',kind:'title'}],
});
`;
    const imports = `import {buildPostingGeneration,PostingReader,type PostingDocument,type PostingPageStore,type PostingCompositePageResult} from 'stringsearchonce';
`;
    writeFileSync(join(dir,'typed.mts'), imports + typed);
    writeFileSync(join(dir,'typed.cts'), imports + typed);
    run(process.execPath, [resolve(root,'node_modules/typescript/bin/tsc'),'--noEmit','--strict','--module','NodeNext','--moduleResolution','NodeNext','--target','ES2022','--skipLibCheck','typed.mts','typed.cts']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
