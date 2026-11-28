import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPostingGeneration, PostingReader } from 'stringsearchonce';

test('raw ID enumeration preserves computed data within the default cache budget', async () => {
  const names = [{ kind: 'title', text: 'needle' }];
  const suffix = '~'.repeat(123);
  const rows = Array.from({ length: 90000 }, (_, ordinal) => ({
    id: String(ordinal).padStart(5, '0') + suffix, names,
  }));
  const byId = new Map(rows.map(row => [row.id, row]));
  const built = buildPostingGeneration(rows, { generation: 'shared-cache-budget', kinds: ['title'] });
  const MiB = 1048576;
  for (const readerOptions of [undefined, { pageCacheBytes: 4 * MiB }, { maxLexiconBytes: 32 * MiB }]) {
    let firstIdReads = 0;
    const reader = new PostingReader(built.manifest, {
      async readPages(generation, kind, pages) {
        assert.equal(generation, built.manifest.generation);
        if (kind === 'ids' && pages.includes(0)) firstIdReads++;
        return new Map(pages.map(page => [page, built.pages.get(kind)[page]]));
      },
    }, readerOptions);
    const options = {
      text: 'needle', limit: 50, fetchSources: async ids => ids.map(id => byId.get(id)),
      getId: row => row.id, getNames: row => row.names,
    };
    const first = await reader.search(options);
    const beforeChunks = reader.counters.chunkDecodes;
    assert(beforeChunks > 0);
    let enumerated = 0;
    for await (const batch of reader.idBatches()) {
      enumerated += batch.length;
      const usage = reader.cacheUsage();
      assert.equal(usage.limit, 42 * MiB);
      assert(usage.pages <= 4 * MiB);
      assert(usage.ids <= 2 * MiB);
      assert(usage.directory + usage.lexicon + usage.chunks <= 36 * MiB);
    }
    assert.equal(enumerated, rows.length);
    const afterEnumeration = reader.cacheUsage();
    assert(afterEnumeration.pages <= 4 * MiB);
    assert(afterEnumeration.chunks > 0);
    assert(afterEnumeration.ids > 0);
    const beforeFirstIdReads = firstIdReads;
    const second = await reader.search(options);
    assert.deepEqual(second.results.map(hit => hit.object.id), first.results.map(hit => hit.object.id));
    assert.equal(reader.counters.chunkDecodes, beforeChunks);
    assert.equal(firstIdReads, beforeFirstIdReads);
    const usage = reader.cacheUsage();
    assert(usage.pages <= 4 * MiB);
    assert(usage.ids <= 2 * MiB);
    assert(usage.directory + usage.lexicon + usage.chunks <= 36 * MiB);
  }
});
