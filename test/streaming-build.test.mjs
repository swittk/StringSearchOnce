import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate } from 'node:timers/promises';
import {
  buildPostingGeneration, buildPostingGenerationFromOrderedDocuments, PostingReader,
} from '../dist/index.js';

const kinds = ['title', 'alias'];
const pageKinds = ['directory', 'lexicon', 'descriptors', 'postings', 'ids'];
const doc = (n, title, alias = '') => ({
  id: String(n).padStart(8, '0'),
  names: [{kind: 'title', text: title}, ...(alias ? [{kind: 'alias', text: alias}] : [])],
});
const texts = [
  'Common Phrase', 'Café 🪴', 'สมชาย ใจดี', 'AJ\u030cZ', 'J\u030cZ blue',
  'H\u0327Z', 'ΟΣ', 'AΟΣ blue', 'İZ', 'AİZ', '\u{10000}end', '\ue000end',
];
const mixed = Array.from({length: 384}, (_, n) =>
  doc(n, texts[n % texts.length], n % 7 ? 'unit blue ' + n % 23 : 'red phrase'));
async function* ordered(rows) { yield* rows; }
async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'posting-stream-'));
  t.after(() => rm(path, {recursive: true, force: true}));
  return path;
}
async function fixture(t, rows, extra = {}) {
  const scratchDirectory = await directory(t);
  const options = {
    generation: 'stream-fixture', kinds, scratchDirectory, runBytes: 32768,
    mergeFanIn: 3, chunkIds: 8, pageBytes: 256, idsPerPage: 17,
    metadataPageBytes: 256, ...extra,
  };
  const pages = new Map(pageKinds.map(kind => [kind, []]));
  const manifest = await buildPostingGenerationFromOrderedDocuments(ordered(rows), options, {
    async writePage(generation, kind, page, bytes) {
      assert.equal(generation, options.generation);
      assert.equal(page, pages.get(kind).length);
      pages.get(kind).push(bytes);
    },
  });
  assert.deepEqual(await readdir(scratchDirectory), []);
  const expected = buildPostingGeneration(rows, options);
  assert.deepEqual(manifest, expected.manifest);
  assert.deepEqual(pages, expected.pages);
  return {manifest, pages, expected};
}
function reader(built) {
  return new PostingReader(built.manifest, {
    async readPages(generation, kind, pages) {
      assert.equal(generation, built.manifest.generation);
      return new Map(pages.map(page => [page, built.pages.get(kind)[page]]));
    },
  });
}

test('ordered spill and multi-level merges reproduce synchronous generation bytes', async t => {
  for (const policy of [
    {runBytes: 8192, mergeFanIn: 2},
    {runBytes: 32768, mergeFanIn: 3},
    {runBytes: 1048576, mergeFanIn: 8},
  ]) await fixture(t, mixed, policy);
});

test('one hot list streams across run, chunk and descriptor-page boundaries', async t => {
  const rows = Array.from({length: 2049}, (_, n) =>
    doc(n, 'Hot Term', n % 19 ? '' : 'Hot Term'));
  const f = await fixture(t, rows, {runBytes: 16384, mergeFanIn: 2, pageBytes: 128});
  assert(f.manifest.descriptorPages > 10);
});

test('streamed pages preserve Unicode matches and continuation source freshness', async t => {
  const f = await fixture(t, mixed, {runBytes: 8192, mergeFanIn: 2});
  const original = reader(f.expected), streamed = reader(f);
  const current = new Map(mixed.map(row => [row.id, row]));
  const options = {
    limit: 7, batchSize: 20, maxSourceCandidates: 12000, maxCursorSteps: 1000000,
    signingKey: 'synthetic-stream-test-key', scopeKey: 'same-current-sources',
    fetchSources: async ids => ids.flatMap(id => current.has(id) ? [current.get(id)] : []),
    getId: row => row.id, getNames: row => row.names,
  };
  for (const text of ['Common', 'Café', '🪴', 'สม', 'AJ', 'J blue', '\u030cZ', '\u0327Z', 'ΟΣ', 'ος', 'İ', '\u{10000}', '\ue000', 'common unit']) {
    for (const caseSensitive of [false, true]) {
      let cursor;
      for (let page = 0; page < 3; page++) {
        const request = {...options, text, caseSensitive, cursor};
        const expected = await original.searchPage(request);
        assert.deepEqual(await streamed.searchPage(request), expected);
        cursor = expected.nextCursor;
        if (!cursor) break;
      }
    }
  }
  const request = {...options, text: 'Common'};
  const first = await original.searchPage(request);
  assert.deepEqual(await streamed.searchPage(request), first);
  current.set(mixed[96].id, doc(96, 'renamed away'));
  current.delete(mixed[108].id);
  const continuation = {...request, cursor: first.nextCursor};
  assert.deepEqual(await streamed.searchPage(continuation), await original.searchPage(continuation));
});

test('empty names and a key spanning many spill buffers preserve exact output', async t => {
  for (const rows of [
    [], [doc(0, '')], [{id: '00000000', names: []}],
    [doc(0, ''), doc(1, 'Z'.repeat(4097)), doc(2, ''), doc(3, 'Hot Term')],
  ]) await fixture(t, rows, {runBytes: 4096, metadataPageBytes: 128});
});

test('input and output are backpressured and pages arrive before source exhaustion', async t => {
  const scratchDirectory = await directory(t);
  const rows = mixed.slice(0, 64);
  let reads = 0, activeWrites = 0, writes = 0, firstWriteAt;
  async function* source() {
    for (const row of rows) {
      assert.equal(activeWrites, 0);
      reads++; yield row;
    }
  }
  const options = {
    generation: 'backpressure-fixture', kinds, scratchDirectory,
    runBytes: 8192, mergeFanIn: 2, idsPerPage: 4, chunkIds: 8,
  };
  const actual = new Map(pageKinds.map(kind => [kind, []]));
  const manifest = await buildPostingGenerationFromOrderedDocuments(source(), options, {
    async writePage(_generation, kind, page, bytes) {
      assert.equal(activeWrites++, 0);
      firstWriteAt ??= reads;
      await setImmediate();
      assert.equal(page, actual.get(kind).length);
      actual.get(kind).push(bytes);
      writes++; activeWrites--;
    },
  });
  assert.equal(firstWriteAt, 4);
  assert.equal(reads, rows.length);
  assert(writes > 1);
  assert.equal(activeWrites, 0);
  const expected = buildPostingGeneration(rows, options);
  assert.deepEqual(manifest, expected.manifest);
  assert.deepEqual(actual, expected.pages);
  assert.deepEqual(await readdir(scratchDirectory), []);
});

test('source and sink errors preserve their identity and clean only owned spill files', async t => {
  const scratchDirectory = await directory(t);
  await writeFile(join(scratchDirectory, 'caller-sentinel'), 'keep');
  const sourceFailure = new Error('source fixture failed');
  async function* source() { yield* mixed.slice(0, 64); throw sourceFailure; }
  const options = {
    generation: 'failure-fixture', kinds, scratchDirectory,
    runBytes: 4096, mergeFanIn: 2, idsPerPage: 4,
  };
  let written = 0;
  await assert.rejects(buildPostingGenerationFromOrderedDocuments(source(), options, {
    async writePage() { written++; },
  }), error => error === sourceFailure);
  assert(written > 0);
  assert.deepEqual(await readdir(scratchDirectory), ['caller-sentinel']);
  const sinkFailure = new Error('sink fixture failed');
  await assert.rejects(buildPostingGenerationFromOrderedDocuments(ordered(mixed), options, {
    async writePage(_generation, kind) { if (kind === 'descriptors') throw sinkFailure; },
  }), error => error === sinkFailure);
  assert.deepEqual(await readdir(scratchDirectory), ['caller-sentinel']);
  assert.equal(await readFile(join(scratchDirectory, 'caller-sentinel'), 'utf8'), 'keep');
});

test('a complete bounded run emits directly without creating a spill file', async t => {
  const scratchDirectory = await directory(t), rows = mixed.slice(0, 64);
  const options = {
    generation: 'direct-fixture', kinds, scratchDirectory,
    runBytes: 1048576, mergeFanIn: 2, idsPerPage: 4, chunkIds: 8,
  };
  const pages = new Map(pageKinds.map(kind => [kind, []]));
  let checkedPostingOutput = false;
  const manifest = await buildPostingGenerationFromOrderedDocuments(ordered(rows), options, {
    async writePage(_generation, kind, page, bytes) {
      if (kind === 'postings') {
        checkedPostingOutput = true;
        for (const entry of await readdir(scratchDirectory, {withFileTypes: true}))
          if (entry.isDirectory())
            assert.deepEqual(await readdir(join(scratchDirectory, entry.name)), []);
      }
      pages.get(kind)[page] = bytes;
    },
  });
  assert(checkedPostingOutput);
  const expected = buildPostingGeneration(rows, options);
  assert.deepEqual(manifest, expected.manifest);
  assert.deepEqual(pages, expected.pages);
  assert.deepEqual(await readdir(scratchDirectory), []);
});
