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

test('a packed one-byte page fits a one-byte output limit', () => {
  const byte = Uint8Array.of(0);
  assert.deepEqual(unpackPostingPage(packPostingPage(byte), 1), byte);
});

test('builder rejects empty kinds before emitting an unreadable manifest', () => {
  assert.throws(
    () => buildPostingGeneration([], { generation: 'fixture-1', kinds: [''] }),
    /POSTING_BUILD_OPTIONS/
  );
});

test('builder accounts for both lexicon page brackets at the inflation limit', async () => {
  // The exact-name entry is first and its one posting uses byte 0 of page 0.
  const entryOverhead = Buffer.byteLength(JSON.stringify(['n""|a', 0]));
  const kind = 'k'.repeat(262144 - 2 - entryOverhead);
  const atLimit = fixture([{ id: 'a', names: [name(kind, 'a')] }], { kinds: [kind] });
  await atLimit.reader.open();
  assert.deepEqual(ids(await atLimit.reader.search(atLimit.options('a'))), ['a']);
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

test('one-character coverage counts the query code points in its matching mode', async () => {
  const f = fixture([doc('a', 'İ'), doc('b', 'İZ'), doc('c', 'AİZ')]);
  const result = await f.reader.search(f.options('I\u0307', { caseSensitive: true }));
  assert.equal(result.coverage, 'prefix-only');
  assert.deepEqual(ids(result), ['a', 'b']);
  const folded = await f.reader.search(f.options('İ'));
  assert.equal(folded.coverage, 'substring');
  assert.deepEqual(ids(folded), ['a', 'b', 'c']);
});

test('short multiword queries use the code points of their matching mode', async () => {
  const f = fixture([doc('a', 'İ x'), doc('b', 'İ 🪴')]);
  await assert.rejects(f.reader.search(f.options('İ x', { caseSensitive: true })), /POSTING_QUERY_TOO_SHORT/);
  assert.deepEqual(ids(await f.reader.search(f.options('İ x'))), ['a']);
  assert.deepEqual(ids(await f.reader.search(f.options('İ 🪴', { caseSensitive: true }))), ['b']);
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

test('a full result batch skips the next intersected candidate until needed', async () => {
  const input = [doc('000', 'Oak desk lamp'), doc('001', 'Oak desk lamp')];
  for (let i = 2; i < 202; i++) {
    input.push(doc(String(i).padStart(3, '0'), i % 2 === 0 ? 'Oak desk' : 'Oak lamp'));
  }
  const f = fixture(input);
  const options = f.options('desk lamp', { limit: 1, maxCursorSteps: 20 });
  assert.deepEqual(ids(await f.reader.search(options)), ['000']);
  const filtered = await f.reader.search({
    ...options, filterCandidates: async rows => rows.filter(row => row.id !== '000'),
  });
  assert.deepEqual(ids(filtered), ['001']);
  const page = await f.reader.searchPage({
    ...options, scopeKey: 'catalog', signingKey: 'fixture-signing-key',
  });
  assert.deepEqual(ids(page), ['000']);
  assert(page.nextCursor);
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

test('rank continuation for a blank query needs no storage', async () => {
  const f = fixture();
  const reader = new PostingReader(f.built.manifest, {
    async readPages() { throw new Error('store unavailable'); },
  });
  const options = f.options(' \t ');
  const expected = await reader.search(options);
  const continued = await reader.searchAfterRank(options, { stage: 'exact', kind: 'title', id: 'a' });
  assert.deepEqual(continued, expected);
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

test('cold ID pages are batched in order and shared across concurrent searches', async () => {
  const input = Array.from({ length: 6 }, (_, i) => doc(String(i), 'Desk'));
  const f = fixture(input, { idsPerPage: 1 }, { idCacheBytes: 0 });
  const options = f.options('desk', { limit: input.length });
  const results = await Promise.all([f.reader.search(options), f.reader.search(options)]);
  const expected = input.map(row => row.id);
  for (const result of results) assert.deepEqual(ids(result), expected);
  assert.deepEqual(ids(await f.reader.search(options)), expected);
  assert.deepEqual(f.reads.filter(read => read.kind === 'ids').map(read => read.pages), [
    [0, 1, 2, 3], [4, 5],
  ]);
});

test('a failed ID page request can be retried', async () => {
  const f = fixture([doc('a', 'Desk'), doc('b', 'Desk')], { idsPerPage: 1 });
  const failure = new Error('temporary store failure');
  let idReads = 0;
  const reader = new PostingReader(f.built.manifest, {
    async readPages(_generation, kind, pages) {
      if (kind === 'ids' && ++idReads === 1) throw failure;
      return new Map(pages.map(page => [page, f.built.pages.get(kind)[page]]));
    },
  });
  const options = f.options('desk', { limit: 2 });
  await assert.rejects(reader.search(options), error => error === failure);
  assert.deepEqual(ids(await reader.search(options)), ['a', 'b']);
  assert.equal(idReads, 2);
});

test('ID enumeration batches cold reads and reuses the reader cache without opening the lexicon', async () => {
  const documents = Array.from({ length: 21 }, (_, i) => doc(String(i).padStart(2, '0'), 'Desk'));
  const { reader, reads } = fixture([...documents].reverse(), { idsPerPage: 2 });
  const first = reader.idBatches();
  assert.deepEqual(reads, []);
  assert.deepEqual((await first.next()).value, ['00', '01']);
  await first.return();
  assert.deepEqual(reads, [{ kind: 'ids', pages: [0, 1, 2, 3, 4, 5, 6, 7] }]);

  const actual = [];
  for await (const batch of reader.idBatches()) actual.push(...batch);
  assert.deepEqual(actual, documents.map(row => row.id));
  assert.deepEqual(reads, [
    { kind: 'ids', pages: [0, 1, 2, 3, 4, 5, 6, 7] },
    { kind: 'ids', pages: [8, 9, 10] },
  ]);
  const empty = fixture([]);
  assert.equal((await empty.reader.idBatches().next()).done, true);
  assert.deepEqual(empty.reads, []);
});

test('composite keyset pages match the exhaustive order across overlapping current streams', async () => {
  const templates = [
    ['Desk', '', 'exact', 'title'],
    ['Cabinet', 'Desk', 'exact', 'alias'],
    ['Desk lamp', '', 'prefix', 'title'],
    ['Cabinet', 'Desk chair', 'prefix', 'alias'],
    ['Cedar desk', '', 'word-prefix', 'all'],
    ['Cedar side-desk', '', 'substring', 'all'],
  ];
  const hits = Array.from({ length: 91 }, (_, i) => {
    const [title, alias, stage, kind] = templates[i % templates.length];
    return { object: doc(String(i).padStart(3, '0'), title, alias), stage, kind };
  });
  const current = hits.map(hit => hit.object);
  // One current name is stale in both indexes, one row is stale in the source,
  // and other nominations are missing, denied or removed by the extra filter.
  const indexed = [...current];
  indexed[24] = doc('024', 'Shelf');
  current[25] = doc('025', 'Shelf');
  const denied = new Set(['002', '033', '061']);
  const filtered = new Set(['007', '041', '071']);
  const allowed = new Map(current.filter(row => row.id !== '022' && !denied.has(row.id)).map(row => [row.id, row]));
  const eligible = current.filter(row => allowed.has(row.id) && !filtered.has(row.id));
  const expected = oracle(eligible, 'desk');
  const base = fixture(indexed.slice(1, 61), { generation: 'base' });
  const delta = fixture(indexed.slice(18, 81), { generation: 'delta' });
  const readers = [base.reader, delta.reader];
  const rank = (stage, kind) => templates.findIndex(entry => entry[2] === stage && entry[3] === kind);
  const liveCalls = [];
  const live = hits.filter(({ object }, index) =>
    (index === 0 || index >= 20) && allowed.get(object.id) === object && !filtered.has(object.id));
  live.sort((a, b) => rank(a.stage, a.kind) - rank(b.stage, b.kind) || (a.object.id < b.object.id ? -1 : 1));
  const options = base.options('desk', {
    fetchSources: async ids => [...ids].reverse().flatMap(id => allowed.has(id) ? [allowed.get(id)] : []),
    filterCandidates: async rows => rows.filter(row => !filtered.has(row.id)),
    scopeKey: 'catalog:member:revision-1',
    signingKey: 'example-server-signing-key',
    readLive: async (after, limit) => {
      liveCalls.push({ after, limit });
      const boundary = after ? rank(after.stage, after.kind) : -1;
      return live.filter(hit => {
        const tier = rank(hit.stage, hit.kind);
        return tier > boundary || (tier === boundary && hit.object.id > after.id);
      }).slice(0, limit).map(hit => ({ ...hit, object: { ...hit.object, viaLive: true } }));
    },
  });

  const whole = fixture(eligible, { generation: 'whole' });
  const single = await whole.reader.search(whole.options('desk', { limit: expected.length }));
  assert.deepEqual(ids(single), expected);
  for (const limit of [1, 7, 29, expected.length, 100]) {
    const actual = [];
    let cursor;
    do {
      const page = await PostingReader.searchCompositePage(readers, { ...options, cursor, limit });
      assert.equal(liveCalls.at(-1).limit, limit + 1);
      assert.equal(page.coverage, 'substring');
      if (page.nextCursor) assert.equal(page.results.length, limit);
      actual.push(...page.results);
      assert(actual.length <= expected.length);
      cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(actual.map(hit => hit.object.id), expected);
    assert.deepEqual(
      actual.map(hit => [hit.object.id, hit.stage, hit.kind]),
      single.results.map(hit => [hit.object.id, hit.stage, hit.kind])
    );
    assert.equal(actual[0].object.viaLive, true);
    assert.equal(actual.find(hit => hit.object.id === '024').object.viaLive, true);
    assert.equal(actual.find(hit => hit.object.id === '030').object.viaLive, undefined);
  }
  // In particular, the first boundary ID exists in neither immutable reader.
  const first = await PostingReader.searchCompositePage(readers, { ...options, limit: 1 });
  assert.deepEqual(ids(first), ['000']);
  const cursor = first.nextCursor;
  assert(cursor);
  const changedDelta = fixture(indexed.slice(18, 81), { generation: 'delta-next' });
  const reads = base.reads.length + delta.reads.length;
  const calls = liveCalls.length;
  for (const [active, changes] of [
    [readers, { scopeKey: 'catalog:member:revision-2' }],
    [readers, { signingKey: 'another-server-signing-key' }],
    [readers, { text: 'Desk' }],
    [readers, { caseSensitive: true }],
    [readers, { readLive: undefined }],
    [readers, { cursor: cursor.replace(/\..+$/, '.bad') }],
    [[delta.reader, base.reader], {}],
    [[base.reader, changedDelta.reader], {}],
  ]) {
    await assert.rejects(PostingReader.searchCompositePage(active, { ...options, cursor, ...changes }), /POSTING_CURSOR_INVALID/);
  }
  assert.equal(base.reads.length + delta.reads.length, reads);
  assert.deepEqual(changedDelta.reads, []);
  assert.equal(liveCalls.length, calls);
});

test('fully overlapping streams load only a bounded ranked prefix and honor lookahead budgets', async () => {
  const documents = Array.from({ length: 400 }, (_, i) => doc(String(i).padStart(4, '0'), 'Desk'));
  const a = fixture(documents, { generation: 'a' });
  const b = fixture(documents, { generation: 'b' });
  const options = a.options('Desk', { limit: 5, scopeKey: 'catalog', signingKey: 'example-server-signing-key' });
  const page = await PostingReader.searchCompositePage([a.reader, b.reader], {
    ...options,
    maxSourceCandidates: 6,
  });
  assert.deepEqual(ids(page), documents.slice(0, 5).map(row => row.id));
  assert(page.nextCursor);
  assert.equal(page.sourceCandidates, 12);
  assert.equal(page.sourceReads, 2);
  for (const { reads } of [a, b]) {
    assert.deepEqual(reads.filter(read => read.kind === 'ids').flatMap(read => read.pages), [0]);
    assert.equal(reads.filter(read => read.kind === 'postings').flatMap(read => read.pages).length, 1);
  }
  await assert.rejects(
    PostingReader.searchCompositePage([a.reader, b.reader], { ...options, maxSourceCandidates: 5 }),
    /POSTING_SOURCE_CANDIDATE_LIMIT/
  );
  const short = fixture(documents.slice(0, 5), { generation: 'short' });
  const exhausted = await PostingReader.searchCompositePage([short.reader], { ...options, maxSourceCandidates: 5 });
  assert.deepEqual(ids(exhausted), ids(page));
  assert.equal(exhausted.nextCursor, undefined);
});

test('composite rejects incompatible query budgets before starting any stream', async () => {
  const { reader, options, reads } = fixture([
    doc('01', 'Desk'), doc('02', 'Desk'), doc('03', 'Desk'), doc('04', 'Desk'), doc('05', 'Desk'),
  ], { idsPerPage: 1 });
  let liveCalls = 0;
  const request = options('desk', {
    limit: 1,
    scopeKey: 'catalog',
    signingKey: 'example-server-signing-key',
    readLive: async () => {
      liveCalls++;
      return [];
    },
  });
  const first = await PostingReader.searchCompositePage([reader], request);
  assert(first.nextCursor);
  const pageReads = reads.length;
  for (const cursor of [undefined, first.nextCursor]) {
    await assert.rejects(
      PostingReader.searchCompositePage([reader], { ...request, cursor, limit: 5, maxSourceCandidates: 2 }),
      /POSTING_QUERY_LIMITS/
    );
  }
  assert.equal(liveCalls, 1);
  assert.equal(reads.length, pageReads);
});

test('composite failure waits for active source reads to settle', async () => {
  const { reader, options, rows } = fixture([doc('01', 'Desk')]);
  let started, finish;
  const reading = new Promise(resolve => { started = resolve; });
  const release = new Promise(resolve => { finish = resolve; });
  const search = PostingReader.searchCompositePage([reader], options('desk', {
    scopeKey: 'catalog',
    signingKey: 'example-server-signing-key',
    fetchSources: async ids => {
      started();
      await release;
      return ids.map(id => rows.get(id));
    },
    readLive: async () => {
      await reading;
      throw new Error('live source failed');
    },
  }));
  let settled = false;
  const rejected = assert.rejects(search, /live source failed/).then(() => { settled = true; });
  await reading;
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
  } finally {
    finish();
  }
  await rejected;
});

test('a current name edit between stream reads cannot duplicate an ID within a page', async () => {
  const { reader, options, rows } = fixture([
    doc('01', 'Desk'), doc('02', 'Cedar desk'), doc('03', 'Desk mat'),
  ]);
  let finishRead;
  const observed = new Promise(resolve => { finishRead = resolve; });
  const page = await PostingReader.searchCompositePage([reader], options('desk', {
    limit: 3,
    scopeKey: 'catalog',
    signingKey: 'example-server-signing-key',
    fetchSources: async ids => {
      const result = ids.map(id => rows.get(id));
      if (ids.includes('01')) finishRead();
      return result;
    },
    readLive: async () => {
      await observed;
      const updated = doc('01', 'Maple desk');
      rows.set(updated.id, updated);
      return [{ object: updated, stage: 'word-prefix', kind: 'all' }];
    },
  }));
  assert.deepEqual(ids(page), ['01', '03', '02']);
  assert.equal(page.nextCursor, undefined);
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


test('opening a large dictionary reads only its sparse fences', async () => {
  const input = Array.from({ length: 2000 }, (_, index) =>
    doc(index.toString().padStart(5, '0'), 'entry' + index.toString().padStart(5, '0'))
  );
  const f = fixture(input, { pageBytes: 1024, metadataPageBytes: 1024 });
  assert(f.built.manifest.lexiconPages > 20);
  await f.reader.open();
  assert(f.reads.length > 0);
  assert(f.reads.every(read => read.kind === 'directory'));
  const result = await f.reader.search(f.options('entry01000', { limit: 1 }));
  assert.deepEqual(ids(result), ['01000']);
  const lexiconPages = new Set(f.reads.filter(read => read.kind === 'lexicon').flatMap(read => read.pages));
  assert(lexiconPages.size < f.built.manifest.lexiconPages / 4);
  const before = f.reads.length;
  assert.deepEqual(ids(await f.reader.search(f.options('entry01000', { limit: 1 }))), ['01000']);
  assert.equal(f.reads.length, before);
});

test('hot terms seek within paged chunk descriptors and preserve signed continuation', async () => {
  const input = Array.from({ length: 1200 }, (_, index) =>
    doc(index.toString().padStart(5, '0'), 'shared phrase')
  );
  const f = fixture(input, { chunkIds: 2, pageBytes: 128, metadataPageBytes: 1024 });
  assert(f.built.manifest.descriptorPages > 100);
  const options = f.options('shared phrase', {
    limit: 5, scopeKey: 'all-rows', signingKey: 'example-server-signing-key',
  });
  const first = await f.reader.searchPage(options);
  assert.deepEqual(ids(first), input.slice(0, 5).map(row => row.id));
  const second = await f.reader.searchPage({ ...options, cursor: first.nextCursor });
  assert.deepEqual(ids(second), input.slice(5, 10).map(row => row.id));
  const suffix = await f.reader.searchAfterRank(options, { stage: 'exact', kind: 'title', id: '01100' });
  assert.deepEqual(ids(suffix), input.slice(1101, 1106).map(row => row.id));
  const loaded = new Set(f.reads.filter(read => read.kind === 'descriptors').flatMap(read => read.pages));
  assert(loaded.size < f.built.manifest.descriptorPages / 4);
});


test('singleton terms stay in the dictionary without posting or descriptor reads', async () => {
  const f = fixture([doc('a', 'Blue desk')]);
  assert.equal(f.built.manifest.postingPages, 0);
  assert.equal(f.built.manifest.descriptorPages, 0);
  for (const text of ['Blue desk', 'desk', 'lue de'])
    assert.deepEqual(ids(await f.reader.search(f.options(text))), ['a']);
  assert(!f.reads.some(read => read.kind === 'postings' || read.kind === 'descriptors'));
});
