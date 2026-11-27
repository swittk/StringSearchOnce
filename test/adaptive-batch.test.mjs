import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPostingGeneration, PostingReader } from 'stringsearchonce';

const row = (ordinal, text = 'needle') => ({
  id: String(ordinal).padStart(3, '0'), names: [{ kind: 'title', text }],
});
const readerFor = rows => {
  const built = buildPostingGeneration(rows, {
    generation: 'adaptive-batch-fixture', kinds: ['title'],
  });
  return new PostingReader(built.manifest, {
    async readPages(_generation, kind, pages) {
      return new Map(pages.map(page => [page, built.pages.get(kind)[page]]));
    },
  });
};
const sourceOptions = rows => {
  const current = new Map(rows.map(row => [row.id, row]));
  return {
    text: 'needle',
    fetchSources: async ids => ids.map(id => current.get(id)).filter(Boolean),
    getId: row => row.id,
    getNames: row => row.names,
  };
};

test('terminal page rejection keeps source fetches batched within the caller ceiling', async () => {
  const rows = Array.from({ length: 100 }, (_, ordinal) => row(ordinal));
  const reader = readerFor(rows), options = sourceOptions(rows), found = [];
  const batches = [];
  let cursor, sourceCandidates = 0, rankCalls = 0;
  do {
    const page = await PostingReader.searchCompositePage([reader], {
      ...options,
      limit: 50, batchSize: 20,
      scopeKey: 'synthetic-sources', signingKey: 'synthetic-page-signing-key', cursor,
      fetchSources: async ids => {
        batches.push(ids.length);
        return options.fetchSources(ids);
      },
      getNames: row => { rankCalls++; return row.names; },
    });
    found.push(...page.results.map(hit => hit.object.id));
    sourceCandidates += page.sourceCandidates;
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(found, rows.map(row => row.id));
  assert.equal(sourceCandidates, 151);
  assert.equal(rankCalls, 151);
  assert(batches.every(size => size <= 20));
  assert(batches.length <= 10, 'A rejected terminal prefix must not become one fetch per source');
});

test('a buffered successful prefix survives the cursor ceiling without raising it', async () => {
  const indexed = Array.from({ length: 25 }, (_, ordinal) => row(ordinal));
  const current = indexed.map((source, ordinal) => ordinal === 0 ? row(ordinal, 'other') : source);
  for (const api of ['search', 'page', 'composite']) {
    const reader = readerFor(indexed), options = {
      ...sourceOptions(current),
      limit: 1, batchSize: 20,
      maxCursorSteps: api === 'search' ? 3 : 5,
      scopeKey: 'synthetic-sources', signingKey: 'synthetic-page-signing-key',
    };
    const page = api === 'search' ? await reader.search(options)
      : api === 'page' ? await reader.searchPage(options)
      : await PostingReader.searchCompositePage([reader], options);
    assert.deepEqual(page.results.map(hit => hit.object.id), ['001']);
    assert.equal(page.cursorSteps, options.maxCursorSteps);
    if (api !== 'search') assert(page.nextCursor);
    const insufficient = { ...options, maxCursorSteps: options.maxCursorSteps - 1 };
    await assert.rejects(
      api === 'search' ? reader.search(insufficient)
        : api === 'page' ? reader.searchPage(insufficient)
        : PostingReader.searchCompositePage([reader], insufficient),
      /POSTING_CURSOR_LIMIT/
    );
  }
});

test('source allowance still bounds speculative reads and signed lookahead', async () => {
  const indexed = Array.from({ length: 25 }, (_, ordinal) => row(ordinal));
  const current = indexed.map((source, ordinal) => ordinal === 0 ? row(ordinal, 'other') : source);
  const reader = readerFor(indexed), options = sourceOptions(current), requested = [];
  await assert.rejects(reader.searchPage({
    ...options,
    limit: 1, batchSize: 20, maxSourceCandidates: 2, maxCursorSteps: 1000,
    scopeKey: 'synthetic-sources', signingKey: 'synthetic-page-signing-key',
    fetchSources: async ids => { requested.push(...ids); return options.fetchSources(ids); },
  }), /POSTING_SOURCE_CANDIDATE_LIMIT/);
  assert.deepEqual(requested, ['000', '001']);
});

test('unused prefetched tail rows do not trigger additional source ranking', async () => {
  const indexed = Array.from({ length: 25 }, (_, ordinal) => row(ordinal));
  const current = indexed.map((source, ordinal) => ordinal === 0 ? row(ordinal, 'other') : source);
  const reader = readerFor(indexed), ranked = [];
  const result = await reader.search({
    ...sourceOptions(current),
    limit: 1, batchSize: 20,
    getNames: source => { ranked.push(source.id); return source.names; },
  });
  assert.deepEqual(result.results.map(hit => hit.object.id), ['001']);
  assert.deepEqual(ranked, ['000', '001']);
});

test('caller errors are not mistaken for the engine cursor ceiling', async () => {
  const indexed = [row(0)];
  const reader = readerFor(indexed), error = new Error('POSTING_CURSOR_LIMIT');
  await assert.rejects(reader.search({
    ...sourceOptions(indexed),
    fetchSources: async () => { throw error; },
  }), caught => caught === error);
});

test('cached later-tier matches remain usable with no source allowance left', async () => {
  const indexed = [row(0), row(1), row(2)];
  const current = [row(0, 'needlework'), row(2, 'needlework')];
  const reader = readerFor(indexed), options = sourceOptions(current), requested = [];
  const result = await reader.search({
    ...options,
    limit: 2, batchSize: 20, maxSourceCandidates: 3,
    fetchSources: async ids => { requested.push(...ids); return options.fetchSources(ids); },
  });
  assert.deepEqual(result.results.map(hit => hit.object.id), ['000', '002']);
  assert.equal(result.sourceCandidates, 3);
  assert.deepEqual(requested, ['000', '001', '002']);

  const pageReader = readerFor(indexed);
  const page = await pageReader.searchPage({
    ...options,
    limit: 1, batchSize: 20, maxSourceCandidates: 3,
    scopeKey: 'synthetic-sources', signingKey: 'synthetic-page-signing-key',
  });
  assert.deepEqual(page.results.map(hit => hit.object.id), ['000']);
  assert(page.nextCursor);
  assert.equal(page.sourceCandidates, 3);
});

test('an uncached denied row between cached matches still consumes source allowance', async () => {
  const indexed = [row(0), row(1, 'needlework'), row(2)];
  const current = [row(0, 'needlework'), row(2, 'needlework')];
  for (const budget of [2, 3]) {
    const reader = readerFor(indexed), options = sourceOptions(current), requested = [];
    const search = reader.search({
      ...options,
      limit: 2, batchSize: 20, maxSourceCandidates: budget,
      fetchSources: async ids => { requested.push(...ids); return options.fetchSources(ids); },
    });
    if (budget === 2) {
      await assert.rejects(search, /POSTING_SOURCE_CANDIDATE_LIMIT/);
      assert.deepEqual(requested, ['000', '002']);
    } else {
      const result = await search;
      assert.deepEqual(result.results.map(hit => hit.object.id), ['000', '002']);
      assert.deepEqual(requested, ['000', '002', '001']);
    }
  }
});

test('clustered rejection adapts without changing a tight source boundary', async () => {
  const indexed = Array.from({ length: 100 }, (_, ordinal) => row(ordinal));
  for (const [firstDenied, lastDenied, limit, required] of [
    [0, 40, 5, 45],
    [20, 80, 30, 90],
  ]) {
    const current = indexed.filter((_, ordinal) => ordinal < firstDenied || ordinal >= lastDenied);
    const expected = current.slice(0, limit).map(source => source.id);
    for (const budget of [required - 1, required]) {
      const reader = readerFor(indexed), options = sourceOptions(current);
      let fetched = 0;
      const search = reader.search({
        ...options,
        limit, batchSize: 20, maxSourceCandidates: budget,
        fetchSources: async ids => { fetched += ids.length; return options.fetchSources(ids); },
      });
      if (budget < required) await assert.rejects(search, /POSTING_SOURCE_CANDIDATE_LIMIT/);
      else assert.deepEqual((await search).results.map(hit => hit.object.id), expected);
      assert(fetched <= budget);
    }
  }
});
