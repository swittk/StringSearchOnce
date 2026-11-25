import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import {
  buildPostingGeneration, buildPostingGenerationInWorker,
  PostingReader, encodePostingIds, decodePostingIds, packPostingPage, unpackPostingPage,
} from 'stringsearchonce';

const kinds = ['title', 'alias', 'tag'];
const name = (kind, text) => ({ kind, text });
const doc = (id, title, alias = '', tag = '') => ({
  id, names: [name('title', title), name('alias', alias), name('tag', tag)],
});
const documents = [
  doc('a', 'Café'),
  doc('b', 'Cafe\u0301'),
  doc('c', 'Café table'),
  doc('d', 'Wooden café chair'),
  doc('e', 'Decaf caféine'),
  doc('f', 'Side table', 'Café'),
  doc('g', 'โต๊ะไม้', 'โต๊ะพับ', 'สีน้ำเงิน'),
  doc('h', 'โคมไฟ', 'สีแดง'),
  doc('i', 'Lamp 🪴'),
  doc('j', 'A cabinet', 'Café table'),
  doc('k', 'Mosaic cabinet', 'Blue ceramic'),
  doc('l', 'Classic lamp', 'Azure'),
];

function fixture(input = documents, overrides = {}, readerOptions) {
  const built = buildPostingGeneration(input, {
    generation: 'fixture-1', kinds, chunkIds: 8, pageBytes: 128, idsPerPage: 8,
    ...overrides,
  });
  return fromBuilt(built, input, readerOptions);
}

function fromBuilt(built, input, readerOptions) {
  const rows = new Map(input.map(row => [row.id, row]));
  const reads = [];
  const store = {
    async readPages(generation, kind, pages) {
      assert.equal(generation, built.manifest.generation);
      reads.push({ kind, pages: [...pages] });
      return new Map(pages.map(page => [page, built.pages.get(kind)[page]]));
    },
  };
  const reader = new PostingReader(built.manifest, store, readerOptions);
  const options = (text, extra = {}) => ({
    text, fetchSources: async ids => ids.flatMap(id => rows.has(id) ? [rows.get(id)] : []),
    getId: row => row.id, getNames: row => row.names, ...extra,
  });
  return { built, rows, reads, reader, options };
}

function oracle(rows, text, { caseSensitive = false, limit = Infinity } = {}) {
  const normalize = value => {
    const canonical = value.normalize('NFC').trim();
    return caseSensitive ? canonical : canonical.toLowerCase().normalize('NFC');
  };
  const phrase = normalize(text);
  const words = phrase.split(/\s+/u).filter(Boolean);
  if (!words.length) return [];
  const prefixOnly = words.length === 1 && [...words[0]].length === 1 && !/^\p{S}$/u.test(words[0]);
  const matches = [];
  for (const row of rows) {
    const names = row.names.map(n => ({ kind: n.kind, text: normalize(n.text) }));
    let rank = Infinity;
    for (const [i, kind] of kinds.entries()) {
      if (names.some(n => n.kind === kind && n.text === phrase)) rank = Math.min(rank, i);
      if (names.some(n => n.kind === kind && n.text.startsWith(phrase))) rank = Math.min(rank, kinds.length + i);
    }
    if (!prefixOnly && rank === Infinity) {
      if (words.every(word => names.some(n => n.text.split(/\s+/u).some(t => t.startsWith(word))))) rank = kinds.length * 2;
      else if (words.every(word => names.some(n => n.text.includes(word)))) rank = kinds.length * 2 + 1;
    }
    if (rank !== Infinity) matches.push({ id: row.id, rank });
  }
  return matches.sort((a,b) => a.rank - b.rank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, limit).map(hit => hit.id);
}
const ids = result => result.results.map(hit => hit.object.id);

test('binary delta-varints and compressed pages round-trip, including sliced views', () => {
  const ordinals = [0, 1, 127, 128, 16384, 4294967294];
  const encoded = encodePostingIds(ordinals);
  const packed = packPostingPage(encoded);
  assert(packed instanceof Uint8Array);
  assert.equal(packed.byteLength, packed.buffer.byteLength);
  const padded = new Uint8Array(packed.length + 8);
  padded.set(packed, 4);
  const unpacked = unpackPostingPage(padded.subarray(4, packed.length + 4), 4096);
  assert.deepEqual([...decodePostingIds(unpacked, ordinals.length, 4294967295)], ordinals);
  assert.throws(() => decodePostingIds(encoded.subarray(0, -1), ordinals.length, 4294967295));
  assert.throws(() => unpackPostingPage(packed, 1));
});

test('builder rejects empty kinds before emitting an unreadable manifest', () => {
  assert.throws(
    () => buildPostingGeneration([], { generation: 'fixture-1', kinds: [''] }),
    /POSTING_BUILD_OPTIONS/
  );
});

test('builder accounts for both lexicon page brackets at the inflation limit', async () => {
  // The exact-name entry is first and its one posting uses byte 0 of page 0.
  const entryOverhead = Buffer.byteLength(JSON.stringify(['n""|a', 1, [[0, 0, 1, 1, 0, 0]]]));
  const kind = 'k'.repeat(262144 - 2 - entryOverhead);
  const atLimit = fixture([{ id: 'a', names: [name(kind, 'a')] }], { kinds: [kind] });
  await atLimit.reader.open();
  const overLimit = kind + 'k';
  assert.throws(
    () => fixture([{ id: 'a', names: [name(overLimit, 'a')] }], { kinds: [overLimit] }),
    /POSTING_LEXICON_ENTRY_TOO_LARGE/
  );
});

test('reader accepts a full ID page with maximum-length JSON-escaped IDs', async () => {
  const input = Array.from({ length: 4096 }, (_, i) => {
    const suffix = i.toString(2).padStart(12, '0').replaceAll('0', '"').replaceAll('1', '\\');
    return { id: '"'.repeat(116) + suffix, names: i === 0 ? [name('title', 'target')] : [] };
  });
  const f = fixture(input, { idsPerPage: 4096 });
  assert.deepEqual(ids(await f.reader.search(f.options('target'))), [input[0].id]);
});

test('all rank tiers, Unicode, cross-field words and single-character coverage match an independent oracle', async () => {
  const f = fixture();
  for (const text of ['café','cafe\u0301','café tab','fé','ceramic blue','ไม้','โต๊ะ น้ำเงิน','🪴','c','a','absent','']) {
    const result = await f.reader.search(f.options(text, { limit: 30 }));
    assert.deepEqual(ids(result), oracle(documents, text), text);
  }
  assert.equal((await f.reader.search(f.options('c'))).coverage, 'prefix-only');
  assert.equal((await f.reader.search(f.options('🪴'))).coverage, 'substring');
  const sensitive = await f.reader.search(f.options('Café', { caseSensitive: true }));
  assert.deepEqual(ids(sensitive), oracle(documents, 'Café', { caseSensitive: true }));
  assert.deepEqual(ids(await f.reader.search(f.options('CAFÉ', { caseSensitive: true }))), []);
});

test('Greek sigma is nominated consistently at exact, prefix and substring positions', async () => {
  const f = fixture([
    doc('a', 'ΟΣ'), doc('b', 'ΟΣΑ'), doc('c', 'ΧΟΣΑ'), doc('d', 'οσα'),
  ]);
  for (const query of ['ΟΣ', 'ος', 'οσ']) {
    assert.deepEqual(ids(await f.reader.search(f.options(query))), ['a', 'b', 'd', 'c']);
  }
  const sensitive = await f.reader.search(f.options('ΟΣ', { caseSensitive: true }));
  assert.deepEqual(ids(sensitive), ['a', 'b', 'c']);
  assert.deepEqual(sensitive.results.map(hit => hit.stage), ['exact', 'prefix', 'substring']);
});

test('case-sensitive coverage counts NFC code points before lowercasing', async () => {
  const f = fixture([doc('a', 'İ'), doc('b', 'İZ'), doc('c', 'AİZ')]);
  const result = await f.reader.search(f.options('I\u0307', { caseSensitive: true }));
  assert.equal(result.coverage, 'prefix-only');
  assert.deepEqual(ids(result), ['a', 'b']);
});

test('case-sensitive nomination preserves boundaries that lowercase NFC changes', async () => {
  const f = fixture([
    doc('a', 'AJ\u030cZ'), doc('b', 'Oak J\u030cZ blue'), doc('c', 'İ\u0327Z'),
  ]);
  for (const [text, expected] of [
    ['AJ\u030cZ', [['a', 'exact']]],
    ['AJ', [['a', 'prefix']]],
    ['J blue', [['b', 'word-prefix']]],
    ['\u030cZ', [['a', 'substring'], ['b', 'substring']]],
    ['\u0327Z', [['c', 'substring']]],
  ]) {
    const result = await f.reader.search(f.options(text, { caseSensitive: true }));
    assert.deepEqual(result.results.map(hit => [hit.object.id, hit.stage]), expected, text);
  }
  assert.deepEqual(ids(await f.reader.search(f.options('aj\u030cz'))), ['a']);
  assert.deepEqual(ids(await f.reader.search(f.options('aJ', { caseSensitive: true }))), []);
});

test('exact and prefix kind priority wins before lower tiers', async () => {
  const f = fixture();
  const result = await f.reader.search(f.options('café', { limit: 30 }));
  assert.deepEqual(ids(result), ['a','b','f','c','j','d','e']);
  assert.deepEqual(result.results.slice(0, 3).map(x => x.stage), ['exact','exact','exact']);
});

test('empty snapshots and missing terms avoid source fetches', async () => {
  for (const input of [[], documents]) {
    const f = fixture(input);
    const result = await f.reader.search(f.options('definitely-absent'));
    assert.deepEqual(result.results, []);
    assert.equal(result.sourceReads, 0);
    assert(!f.reads.some(read => read.kind === 'postings' || read.kind === 'ids'));
  }
});

test('live source verification removes stale, deleted, and denied nominations before the limit', async () => {
  const f = fixture();
  f.rows.delete('a');
  f.rows.set('b', doc('b','Renamed'));
  const options = f.options('café', {
    limit: 3,
    fetchSources: async requested => requested.flatMap(id => id !== 'f' && f.rows.has(id) ? [f.rows.get(id)] : []),
    filterCandidates: async rows => rows.filter(row => row.id !== 'c'),
  });
  const result = await f.reader.search(options);
  assert.deepEqual(ids(result), ['j','d','e']);
  assert(result.sourceCandidates >= 5);
});

test('source verification distinguishes falsy fetched rows from missing and denied rows', async () => {
  const f = fixture([doc('0', 'target'), doc('1', 'target'), doc('2', 'target'), doc('3', 'target')]);
  const getId = value => value === undefined ? '1' : String(value);
  const result = await f.reader.search(f.options('target', {
    fetchSources: async () => [0, undefined, 2],
    getId,
    getNames: value => f.rows.get(getId(value)).names,
    filterCandidates: async rows => rows.filter(value => value !== 2),
  }));
  assert.deepEqual(result.results.map(hit => hit.object), [0, undefined]);
});

test('source ID extraction takes one argument even with a candidate filter', async () => {
  const f = fixture([doc('a', 'Desk'), doc('b', 'Desk')]);
  const result = await f.reader.search(f.options('desk', {
    getId: (row, prefix = '') => prefix + row.id,
    filterCandidates: async rows => rows.filter(row => row.id === 'b'),
  }));
  assert.deepEqual(ids(result), ['b']);
});

test('signed keyset pages fill across rank tiers and reject changed scope, query, and generation', async () => {
  const f = fixture();
  const options = f.options('café', { limit: 2, scopeKey: 'demo:catalog:visible', signingKey: 'synthetic-test-signing-key' });
  const found = [];
  const cursors = new Set();
  let cursor;
  do {
    const page = await f.reader.searchPage({ ...options, cursor });
    found.push(...ids(page));
    cursor = page.nextCursor;
    if (cursor) {
      assert(!cursors.has(cursor));
      cursors.add(cursor);
    }
  } while (cursor);
  assert.deepEqual(found, oracle(documents,'café'));
  const first = [...cursors][0];
  assert(first);
  for (const patch of [
    { scopeKey: 'another-scope' }, { text: 'cabinet' }, { caseSensitive: true },
    { cursor: first.slice(0, first.indexOf('.') + 1) + 'invalid' },
  ]) await assert.rejects(f.reader.searchPage({ ...options, cursor: first, ...patch }), /POSTING_CURSOR_INVALID/);
  const other = fixture(documents, { generation: 'fixture-2' });
  await assert.rejects(other.reader.searchPage({ ...options, cursor: first }), /POSTING_CURSOR_INVALID/);
});

test('signed page lookahead respects the caller candidate budget', async () => {
  const f = fixture([doc('a', 'Blue desk'), doc('b', 'Desk')]);
  const options = f.options('blue desk', {
    limit: 1, maxSourceCandidates: 1,
    scopeKey: 'demo:catalog:visible', signingKey: 'synthetic-test-signing-key',
  });
  const page = await f.reader.searchPage(options);
  assert.deepEqual(ids(page), ['a']);
  assert.equal(page.sourceCandidates, 1);
  assert.equal(page.nextCursor, undefined);
  await assert.rejects(f.reader.searchPage({ ...options, limit: 2 }), /POSTING_QUERY_LIMITS/);

  const fetched = [];
  await assert.rejects(f.reader.searchPage({
    ...options,
    text: 'desk',
    fetchSources: async requested => {
      fetched.push(...requested);
      return options.fetchSources(requested);
    },
  }), /POSTING_SOURCE_CANDIDATE_LIMIT/);
  assert.deepEqual(fetched, ['b']);
});

test('rank/ID continuation need not refer to an object in the snapshot', async () => {
  const f = fixture();
  const result = await f.reader.searchAfterRank(f.options('café', { limit: 30 }), {
    stage: 'exact', kind: 'title', id: 'ab',
  });
  assert.deepEqual(ids(result), oracle(documents,'café').slice(1));
});

test('continuation intersects only the suffix of the saved tier', async () => {
  for (const [stage, prefix] of [['word-prefix', 'Oak '], ['substring', 'Oak X']]) {
    const input = Array.from({ length: 200 }, (_, i) =>
      doc(String(i).padStart(4, '0'), prefix + (i % 2 === 0 ? 'desk' : 'lamp'))
    );
    input.push(doc('0200', prefix + 'desk ' + prefix + 'lamp'));
    const f = fixture(input);
    const result = await f.reader.searchAfterRank(f.options('desk lamp', {
      limit: 1, maxCursorSteps: 20,
    }), { stage, kind: 'all', id: '0199' });
    assert.deepEqual(ids(result), ['0200'], stage);
    assert.equal(result.results[0].stage, stage);
  }
});

test('repeated query words share their word-prefix lookup work', async () => {
  const f = fixture([doc('a', 'Oak desktop'), doc('b', 'Oak desks')]);
  const single = await f.reader.search(f.options('desk'));
  const repeated = await f.reader.search(f.options('desk desk desk'));
  assert.deepEqual(ids(repeated), ['a', 'b']);
  assert.equal(repeated.cursorSteps, single.cursorSteps);
});

test('query entrypoints reject oversized blanks before reading index pages', async () => {
  const f = fixture();
  const options = f.options(' '.repeat(513));
  const signed = { ...options, scopeKey: 'demo:catalog:visible', signingKey: 'synthetic-test-signing-key' };
  await assert.rejects(f.reader.search(options), /POSTING_QUERY_TOO_LONG/);
  await assert.rejects(f.reader.searchPage(signed), /POSTING_QUERY_TOO_LONG/);
  await assert.rejects(
    f.reader.searchAfterRank(options, { stage: 'exact', kind: 'title', id: 'a' }),
    /POSTING_QUERY_TOO_LONG/
  );
  assert.deepEqual(ids(await f.reader.search(f.options(' \t '))), []);
  assert.deepEqual(f.reads, []);
});

test('prefix term limits accept an exact fit and reject the first excess', async () => {
  const f = fixture([
    doc('a', 'Desk lamp'), doc('b', 'Desk mat'), doc('c', 'Dusk'),
  ], {}, { maxMatchedTerms: 2 });
  assert.deepEqual(ids(await f.reader.search(f.options('desk'))), ['a', 'b']);
  await assert.rejects(f.reader.search(f.options('d')), /POSTING_MATCHED_TERM_LIMIT/);
});

test('broad repeated terms retrieve only a bounded ranked prefix and reuse warm decodes', async () => {
  const input = Array.from({ length: 4096 }, (_, i) => doc(String(i).padStart(5,'0'), 'Generic lamp', 'Shade '+i));
  const f = fixture(input, { chunkIds: 64, pageBytes: 1024, idsPerPage: 64 });
  const result = await f.reader.search(f.options('generic lamp', { limit: 10 }));
  assert.deepEqual(ids(result), input.slice(0, 10).map(row => row.id));
  assert.equal(result.sourceCandidates, 10);
  assert(result.sourceReads <= 2);
  const postingPages = f.reads.filter(r => r.kind === 'postings').flatMap(r => r.pages);
  assert(postingPages.length < f.built.manifest.postingPages);
  const pageDecodes = f.reader.counters.pageDecodes;
  const chunkDecodes = f.reader.counters.chunkDecodes;
  for (let i=0;i<8;i++) {
    assert.deepEqual(ids(await f.reader.search(f.options('generic lamp', { limit: 10 }))), ids(result));
  }
  assert.equal(f.reader.counters.pageDecodes, pageDecodes);
  assert.equal(f.reader.counters.chunkDecodes, chunkDecodes);
  // Fetches source rows anew even with a warm posting cache.
  f.rows.delete(input[0].id);
  assert.equal(ids(await f.reader.search(f.options('generic lamp')))[0], input[1].id);
});

test('worker builds identical binary pages while the calling event loop progresses', async () => {
  const input = Array.from({ length: 600 }, (_, i) => doc('r'+i, 'Blue desk '+i, 'Desk'));
  input[256].names = [];
  input[257].names = [name('title', 'Blue desk 257')];
  const options = { generation: 'worker-fixture', kinds };
  const direct = buildPostingGeneration(input, options);
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 1);
  try {
    const worker = await buildPostingGenerationInWorker(input, options);
    assert.deepEqual(worker, direct);
    assert(ticks > 0);
    const f = fromBuilt(worker, input);
    assert.deepEqual(ids(await f.reader.search(f.options('blue desk'))), oracle(input,'blue desk',{limit:10}));
  } finally { clearInterval(timer); }
});

test('worker builds use selected fields on typed documents, names and options', async () => {
  class Name {
    get kind() { return 'title'; }
    get text() { return 'desk'; }
  }
  class Document {
    get id() { return 'a'; }
    get names() { return [new Name()]; }
  }
  class Options {
    get generation() { return 'worker-fixture'; }
    get kinds() { return kinds; }
  }
  const input = [new Document()];
  const options = new Options();
  assert.deepEqual(await buildPostingGenerationInWorker(input, options), buildPostingGeneration(input, options));
});

test('worker ignores unrelated fields after the first batch', async () => {
  const input = Array.from({ length: 257 }, (_, i) => doc(String(i), 'desk'));
  input[256].extra = () => {};
  const options = { generation: 'worker-fixture', kinds };
  assert.deepEqual(await buildPostingGenerationInWorker(input, options), buildPostingGeneration(input, options));
});

test('worker rejects when preparing an acknowledged batch fails', async () => {
  const input = Array.from({ length: 256 }, (_, i) => doc(String(i), 'desk'));
  const failure = new Error('source unavailable');
  input.push({ id: '256', get names() { throw failure; } });
  const options = { generation: 'worker-fixture', kinds };
  await assert.rejects(buildPostingGenerationInWorker(input, options), error => error === failure);
});

test('CommonJS consumer includes a working compiled worker', async () => {
  const require = createRequire(import.meta.url);
  const cjs = require('stringsearchonce');
  const options = { generation: 'cjs-fixture', kinds };
  const result = await cjs.buildPostingGenerationInWorker(documents, options);
  assert.deepEqual(result, cjs.buildPostingGeneration(documents, options));
});

test('aborted worker builds reject and close', async () => {
  const controller = new AbortController();
  controller.signal.addEventListener('abort', event => event.stopImmediatePropagation());
  const pending = buildPostingGenerationInWorker(documents, { generation: 'abort-fixture', kinds }, controller.signal);
  controller.abort();
  await assert.rejects(pending, /POSTING_BUILD_CANCELLED/);
});
