import assert from 'node:assert/strict';
import { createHook } from 'node:async_hooks';
import { test } from 'node:test';
import { buildPostingGeneration, PostingReader } from 'stringsearchonce';

test('disjoint overlapping chunks keep pending seek continuations bounded', async () => {
  const peaks = [];
  for (const documents of [1024, 32768]) {
    const rows = Array.from({ length: documents }, (_, ordinal) => ({
      id: String(ordinal).padStart(8, '0'),
      names: [{ kind: 'title', text: ordinal % 2 ? 'bb' : 'aa' }],
    }));
    const built = buildPostingGeneration(rows, {
      generation: 'disjoint-windows-' + documents, kinds: ['title'], chunkIds: 4,
    });
    const reader = new PostingReader(built.manifest, {
      async readPages(_generation, kind, pages) {
        return new Map(pages.map(page => [page, built.pages.get(kind)[page]]));
      },
    });
    const options = {
      text: 'aa bb', limit: 1,
      fetchSources: async () => { assert.fail('Disjoint postings must not nominate sources'); },
      getId: row => row.id, getNames: row => row.names,
    };
    const first = await reader.search(options);
    const pending = new Set();
    let peak = 0;
    const hook = createHook({
      init(id, type) {
        if (type !== 'PROMISE') return;
        pending.add(id);
        peak = Math.max(peak, pending.size);
      },
      promiseResolve(id) { pending.delete(id); },
    });
    let result;
    hook.enable();
    try { result = await reader.search(options); }
    finally { hook.disable(); }
    assert.deepEqual(result.results, []);
    assert.equal(result.sourceCandidates, 0);
    assert.equal(result.cursorSteps, first.cursorSteps);
    peaks.push(peak);
  }
  assert(peaks[1] <= peaks[0] + 16,
    `Pending continuations grew with the window count: ${peaks[0]} to ${peaks[1]}`);
});
