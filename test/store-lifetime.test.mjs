import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildPostingGeneration, PostingReader, postingGrams, unpackPostingPage,
} from 'stringsearchonce';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const emptySources = text => ({
  text, fetchSources: async () => [], getId: row => row.id, getNames: row => row.names,
});

async function overlappingFailure(built, kind, sharedPage, ownedPage, startShared, startOwned) {
  const sharedGate = deferred(), ownedGate = deferred();
  const sharedStarted = deferred(), ownedStarted = deferred();
  const failure = new Error('temporary page-store failure');
  let sharedUsed = false, ownedUsed = false, ownedActive = false, ownedSettled = false;
  const reader = new PostingReader(built.manifest, {
    async readPages(generation, pageKind, pages) {
      assert.equal(generation, built.manifest.generation);
      if (pageKind === kind && pages.includes(sharedPage) && !sharedUsed) {
        sharedUsed = true;
        sharedStarted.resolve();
        await sharedGate.promise;
      } else if (pageKind === kind && pages.includes(ownedPage) && !ownedUsed) {
        ownedUsed = true;
        ownedActive = true;
        ownedStarted.resolve();
        try { await ownedGate.promise; }
        finally { ownedActive = false; }
      }
      return new Map(pages.map(page => [page, built.pages.get(pageKind)[page]]));
    },
  });
  let shared, owned;
  try {
    shared = assert.rejects(startShared(reader), error => error === failure);
    await sharedStarted.promise;
    owned = assert.rejects(startOwned(reader), error => error === failure)
      .then(() => { ownedSettled = true; });
    await ownedStarted.promise;
    sharedGate.reject(failure);
    await shared;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(ownedActive, true);
    assert.equal(ownedSettled, false, 'the request still owns its other store callback');
    ownedGate.resolve();
    await owned;
    assert.equal(ownedActive, false);
  } finally {
    sharedGate.resolve();
    ownedGate.resolve();
    await Promise.allSettled([shared, owned]);
  }
  return startOwned(reader);
}

test('concurrent gram lookups settle their own reads after a shared read fails', { timeout: 10000 }, async () => {
  const texts = ['aceqfvmol', 'acezxttam', 'acejkrpar', 'acewxyzab',
    'molaqfvcyp', 'molzxttam', 'paraqfvace', 'parzxtmol'];
  const built = buildPostingGeneration(texts.map((text, i) => ({
    id: String(i), names: [{ kind: 'title', text: 'prefix ' + text + ' suffix' }],
  })), { generation: 'parallel-lexicon', kinds: ['title'], metadataPageBytes: 128 });
  const directory = built.pages.get('directory').flatMap(bytes =>
    JSON.parse(Buffer.from(unpackPostingPage(bytes, 262144)).toString('utf8')));
  const pagesFor = text => [...new Set(postingGrams(text, 3).map(term =>
    directory.find(entry => entry[0] >= term)?.[1]))].slice(0, 4);
  const sharedPages = pagesFor(texts[0]), ownedPages = pagesFor(texts[2]);
  const sharedPage = ownedPages.find(page => sharedPages.includes(page));
  const ownedPage = ownedPages.find(page => !sharedPages.includes(page));
  assert.notEqual(sharedPage, undefined);
  assert.notEqual(ownedPage, undefined);
  const retry = await overlappingFailure(built, 'lexicon', sharedPage, ownedPage,
    reader => reader.search(emptySources(texts[0])),
    reader => reader.search(emptySources(texts[2])));
  assert.deepEqual(retry.results, []);
});

test('concurrent searches and enumeration settle their own ID reads on shared failure', { timeout: 10000 }, async () => {
  const rows = Array.from({ length: 8193 }, (_, i) => ({
    id: String(i).padStart(5, '0'),
    names: i === 0 || i === 8192 ? [{ kind: 'title', text: 'target' }] : [],
  }));
  const byId = new Map(rows.map(row => [row.id, row]));
  const built = buildPostingGeneration(rows, { generation: 'parallel-ids', kinds: ['title'] });
  const search = reader => reader.search({
    text: 'target', fetchSources: async ids => ids.map(id => byId.get(id)),
    getId: row => row.id, getNames: row => row.names,
  });
  const enumerate = reader => reader.idBatches().next();
  const searchRetry = await overlappingFailure(built, 'ids', 0, 8, enumerate, search);
  assert.deepEqual(searchRetry.results.map(hit => hit.object.id), ['00000', '08192']);
  const enumerationRetry = await overlappingFailure(built, 'ids', 0, 1, search, enumerate);
  assert.equal(enumerationRetry.done, false);
  assert.deepEqual(enumerationRetry.value, rows.slice(0, 1024).map(row => row.id));
});
