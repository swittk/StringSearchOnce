import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPostingGeneration, PostingReader } from 'stringsearchonce';

test('sparse cached IDs retain order across ranges, growth and fresh source changes', async () => {
  const selected = [0, 1, 2, 3, 8, 12, 16, 256, 257, 1023, 4096, 8192, 16380, 16381, 16382, 16383, 16384];
  const selectedIndex = new Map(selected.map((ordinal, index) => [ordinal, index]));
  const rows = Array.from({ length: 16385 }, (_, ordinal) => {
    const at = selectedIndex.get(ordinal);
    return {
      id: String(ordinal).padStart(5, '0') + '~'.repeat(ordinal % 11 === 0 ? 123 : ordinal % 8),
      names: at === undefined ? [] : [{ kind: 'title', text: 'needle ' + (at % 2 ? 'odd' : 'even') }],
    };
  });
  const current = new Map(rows.map(row => [row.id, row]));
  const excluded = new Set();
  const built = buildPostingGeneration(rows, { generation: 'sparse-cached-ids', kinds: ['title'] });
  const reader = new PostingReader(built.manifest, {
    async readPages(generation, kind, pages) {
      assert.equal(generation, built.manifest.generation);
      return new Map(pages.map(page => [page, built.pages.get(kind)[page]]));
    },
  });
  let sourceReads = 0;
  const options = text => ({
    text, limit: 50,
    async fetchSources(ids) {
      sourceReads++;
      return ids.filter(id => current.has(id) && !excluded.has(id)).map(id => current.get(id));
    },
    getId: row => row.id, getNames: row => row.names,
  });
  const matchingIds = selected.map(ordinal => rows[ordinal].id);
  for (const group of ['odd', 'even', 'odd', 'even']) {
    const result = await reader.search(options(group));
    assert.deepEqual(result.results.map(hit => hit.object.id),
      matchingIds.filter((_, index) => Boolean(index % 2) === (group === 'odd')));
  }
  const pagedIds = [];
  let cursor;
  do {
    const page = await reader.searchPage({
      ...options('needle'), limit: 3, cursor,
      signingKey: 'cached-id-order-signing-key', scopeKey: 'visible',
    });
    pagedIds.push(...page.results.map(hit => hit.object.id));
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(pagedIds, matchingIds);
  current.delete(matchingIds[0]);
  current.set(matchingIds[1], { ...current.get(matchingIds[1]), names: [{ kind: 'title', text: 'renamed' }] });
  excluded.add(matchingIds[2]);
  const beforeReads = sourceReads;
  const fresh = await reader.search(options('needle'));
  assert.deepEqual(fresh.results.map(hit => hit.object.id), matchingIds.slice(3));
  assert(sourceReads > beforeReads);
  assert(reader.cacheUsage().ids <= 2 * 1048576);
});

let longIdFixture;
function denseLongIds() {
  if (!longIdFixture) {
    const rows = Array.from({ length: 65536 }, (_, ordinal) => ({
      id: String(ordinal).padStart(5, '0') + '~'.repeat(123),
      names: ordinal < 16384 ? [
        { kind: 'title', text: ordinal < 10000 ? 'front' : 'back' },
        ...(ordinal >= 15000 ? [{ kind: 'title', text: 'tail' }] : []),
      ] : [],
    }));
    longIdFixture = {
      rows, byId: new Map(rows.map(row => [row.id, row])),
      built: buildPostingGeneration(rows, { generation: 'dense-long-ids', kinds: ['title'] }),
    };
  }
  const { rows, byId, built } = longIdFixture;
  let idReads = 0, sourceReads = 0;
  const reader = new PostingReader(built.manifest, {
    async readPages(generation, kind, pages) {
      assert.equal(generation, built.manifest.generation);
      if (kind === 'ids') idReads += pages.length;
      return new Map(pages.map(page => [page, built.pages.get(kind)[page]]));
    },
  });
  return {
    reader, rows,
    reads: () => ({ ids: idReads, sources: sourceReads }),
    search: (text, limit) => reader.search({
      text, limit,
      async fetchSources(ids) { sourceReads++; return ids.map(id => byId.get(id)); },
      getId: row => row.id, getNames: row => row.names,
    }),
    async evictRawPages() {
      let count = 0;
      for await (const ids of reader.idBatches()) count += ids.length;
      assert.equal(count, rows.length);
      const usage = reader.cacheUsage();
      assert(usage.pages <= 4 * 1048576);
      assert(usage.ids <= 2 * 1048576);
    },
  };
}

test('a dense long-ID working set survives the last cache-buffer growth step', async () => {
  const fixture = denseLongIds();
  const first = await fixture.search('front', 10000);
  assert.deepEqual(first.results.map(hit => hit.object.id), fixture.rows.slice(0, 10000).map(row => row.id));
  await fixture.evictRawPages();
  const before = fixture.reads();
  const repeated = await fixture.search('front', 10000);
  assert.deepEqual(repeated.results.map(hit => hit.object.id), first.results.map(hit => hit.object.id));
  assert.equal(fixture.reads().ids, before.ids, 'the fitting working set remains cached');
  assert(fixture.reads().sources > before.sources);
});

test('a saturated long-ID block admits a later fitting hot tail', async () => {
  const fixture = denseLongIds();
  await fixture.search('front', 10000);
  await fixture.search('back', 6384);
  const first = await fixture.search('tail', 1384);
  assert.deepEqual(first.results.map(hit => hit.object.id), fixture.rows.slice(15000, 16384).map(row => row.id));
  await fixture.evictRawPages();
  const before = fixture.reads();
  const repeated = await fixture.search('tail', 1384);
  assert.deepEqual(repeated.results.map(hit => hit.object.id), first.results.map(hit => hit.object.id));
  assert.equal(fixture.reads().ids, before.ids, 'newly requested tail IDs replace the saturated block');
  assert(fixture.reads().sources > before.sources);
});
