import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  POSTING_INDEX_COMPATIBILITY_VERSION,
  PostingReader,
  buildPostingGeneration,
} from '../dist/index.js';

const fixture = JSON.parse(readFileSync(
  new URL('./fixtures/posting-v0-1-1.json', import.meta.url), 'utf8'
));
const sources = new Map(fixture.documents.map(row => [row.id, row]));

const checkQueries = async reader => {
  for (const query of fixture.queries) {
    const result = await reader.search({
      text: query.text,
      caseSensitive: query.caseSensitive,
      limit: 100,
      maxSourceCandidates: 500,
      fetchSources: async ids => ids.map(id => sources.get(id)),
      getId: row => row.id,
      getNames: row => row.names,
    });
    assert.deepEqual(
      result.results.map(hit => ({
        id: hit.object.id, stage: hit.stage, kind: hit.kind,
      })),
      query.hits,
      JSON.stringify({ text: query.text, caseSensitive: query.caseSensitive })
    );
  }
};

test('current index contract reads the frozen 0.1.1 generation', async () => {
  assert.equal(POSTING_INDEX_COMPATIBILITY_VERSION, 0);
  assert.equal(fixture.manifest.format, POSTING_INDEX_COMPATIBILITY_VERSION);
  const reader = new PostingReader(fixture.manifest, {
    async readPages(_generation, kind, pages) {
      return new Map(pages.map(page => [
        page, Buffer.from(fixture.pages[kind][page], 'base64'),
      ]));
    },
  });
  await checkQueries(reader);
});

test('current builder preserves the previous index contract query semantics', async () => {
  const built = buildPostingGeneration(fixture.documents, {
    generation: 'current-compatible-generation',
    kinds: fixture.manifest.kinds,
    chunkIds: 4,
    pageBytes: 1024,
    idsPerPage: 4,
  });
  assert.equal(built.manifest.format, POSTING_INDEX_COMPATIBILITY_VERSION);
  const reader = new PostingReader(built.manifest, {
    async readPages(_generation, kind, pages) {
      return new Map(pages.map(page => [page, built.pages.get(kind)[page]]));
    },
  });
  await checkQueries(reader);
});
