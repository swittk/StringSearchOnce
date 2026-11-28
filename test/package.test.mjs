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
if (POSTING_INDEX_COMPATIBILITY_VERSION !== 1) throw Error('Bad index compatibility export');
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
const allIds = [];
for await (const ids of reader.idBatches()) allIds.push(...ids);
if (allIds.length !== 1 || allIds[0] !== '01') throw Error('Bad ID sequence');
const page = await PostingReader.searchCompositePage([reader], {
  ...search, scopeKey:'catalog', signingKey:'example-server-signing-key',
});
if (page.results[0]?.object.id !== '01') throw Error('Bad composite result');
const streamedPages = new Map();
const streamedManifest = await buildPostingGenerationFromOrderedDocuments(
  (async function* () { yield* rows; })(),
  {generation:'streamed',kinds:['title'],scratchDirectory:'.',runBytes:1024,mergeFanIn:2},
  {async writePage(_generation,kind,page,bytes) {
    let pages=streamedPages.get(kind);
    if (!pages) { pages=[]; streamedPages.set(kind,pages); }
    pages[page]=bytes;
  }}
);
const streamedReader = new PostingReader(streamedManifest,{
  async readPages(_generation,kind,pages) {
    return new Map(pages.map(page=>[page,streamedPages.get(kind)[page]]));
  }
});
if ((await streamedReader.search(search)).results[0]?.object.id !== '01')
  throw Error('Bad streamed consumer result');
`;
    const esm = `import {POSTING_INDEX_COMPATIBILITY_VERSION,buildPostingGenerationInWorker,buildPostingGenerationFromOrderedDocuments,PostingReader} from 'stringsearchonce';\n` + body;
    writeFileSync(join(dir,'esm.mjs'), esm);
    writeFileSync(join(dir,'cjs.cjs'), `const {POSTING_INDEX_COMPATIBILITY_VERSION,buildPostingGenerationInWorker,buildPostingGenerationFromOrderedDocuments,PostingReader}=require('stringsearchonce');
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
const indexCompatibility: 1 = POSTING_INDEX_COMPATIBILITY_VERSION;
const rows: PostingDocument[] = [{id:'01',names:[{kind:'title',text:'Desk'}]}];
const built = buildPostingGeneration(rows,{generation:'test',kinds:['title']});
const store: PostingPageStore = {async readPages(_generation,kind,pages) {
  return new Map(pages.map(page=>[page,built.pages.get(kind)![page]!]));
}};
const reader = new PostingReader(built.manifest,store);
const batches: AsyncIterable<readonly string[]> = reader.idBatches();
const buildOptions: BuildOrderedPostingOptions = {
  generation:'streamed',kinds:['title'],scratchDirectory:'.',runBytes:1024,mergeFanIn:2,
};
const sink: PostingPageSink = {async writePage(_generation,_kind,_page,_bytes) {}};
const manifest: Promise<PostingManifest> = buildPostingGenerationFromOrderedDocuments(
  (async function* () { yield* rows; })(), buildOptions, sink
);
const page: Promise<PostingCompositePageResult<PostingDocument>> = PostingReader.searchCompositePage([reader],{
  text:'desk',fetchSources:async()=>rows,getId:row=>row.id,getNames:row=>row.names,
  scopeKey:'catalog',signingKey:'example-server-signing-key',
  readLive:async(after,limit)=>after?.id === '01' || !limit ? [] : [{object:rows[0],stage:'exact',kind:'title'}],
});
`;
    const imports = `import {POSTING_INDEX_COMPATIBILITY_VERSION,buildPostingGeneration,buildPostingGenerationFromOrderedDocuments,PostingReader,type PostingDocument,type PostingPageStore,type PostingPageSink,type PostingManifest,type BuildOrderedPostingOptions,type PostingCompositePageResult} from 'stringsearchonce';
`;
    writeFileSync(join(dir,'typed.mts'), imports + typed);
    writeFileSync(join(dir,'typed.cts'), imports + typed);
    run(process.execPath, [resolve(root,'node_modules/typescript/bin/tsc'),'--noEmit','--strict','--module','NodeNext','--moduleResolution','NodeNext','--target','ES2022','--skipLibCheck','typed.mts','typed.cts']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
