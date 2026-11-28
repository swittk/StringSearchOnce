import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPostingGeneration, PostingReader } from 'stringsearchonce';

const idFor = (ordinal) => String(ordinal).padStart(8, '0');
const matches = (row) => ['ree', 'lue'].every(word => row.names.some(name => name.text.includes(word)));
const green = { kind: 'title', text: 'green' };
const blue = { kind: 'alias', text: 'blue' };

function fixture(rows, chunkIds) {
  const built = buildPostingGeneration(rows, {
    generation: 'chunk-geometry', kinds: ['title', 'alias'], chunkIds,
  });
  const current = new Map(rows.map(row => [row.id, row]));
  const reader = new PostingReader(built.manifest, {
    async readPages(generation, kind, numbers) {
      assert.equal(generation, built.manifest.generation);
      return new Map(numbers.map(number => [number, built.pages.get(kind)[number]]));
    },
  });
  const options = {
    text: 'ree lue', limit: 5,
    signingKey: 'chunk-geometry-signing-key', scopeKey: 'visible',
    fetchSources: async ids => ids.flatMap(id => {
      const row = current.get(id);
      return row && row.visible !== false ? [row] : [];
    }),
    getId: row => row.id,
    getNames: row => row.names,
  };
  return { reader, current, options };
}

async function remaining(reader, options, cursor) {
  const ids = [];
  do {
    const page = await reader.searchPage({ ...options, cursor });
    ids.push(...page.results.map(hit => hit.object.id));
    cursor = page.nextCursor;
  } while (cursor);
  return ids;
}

test('dense local intersections cross bit and chunk boundaries and recheck current sources', async () => {
  const rows = Array.from({ length: 420 }, (_, ordinal) => ({
    id: idFor(ordinal),
    names: ordinal >= 19 && ordinal <= 350
      ? ordinal % 11 ? [green, blue] : [green] : [],
    visible: ordinal % 5 !== 0,
  }));
  const { reader, current, options } = fixture(rows, 64);
  const first = await reader.searchPage({ ...options, limit: 17 });
  const initial = rows.filter(row => row.visible && matches(row)).map(row => row.id);
  assert.deepEqual(first.results.map(hit => hit.object.id), initial.slice(0, 17));
  assert(first.nextCursor);
  const after = first.results.at(-1).object.id;
  const later = rows.filter(row => row.id > after && matches(row));
  const laterVisible = later.filter(row => row.visible);
  current.set(laterVisible[0].id, { ...laterVisible[0], visible: false });
  current.set(laterVisible[1].id, { ...laterVisible[1], names: [green] });
  const newlyVisible = later.find(row => !row.visible);
  current.set(newlyVisible.id, { ...newlyVisible, visible: true });
  const expected = [...current.values()]
    .filter(row => row.id > after && row.visible && matches(row)).map(row => row.id);
  assert.deepEqual(await remaining(reader, options, first.nextCursor), expected);
  assert.deepEqual(await remaining(reader, { ...options, text: 'lue ree' }),
    [...current.values()].filter(row => row.visible && matches(row)).map(row => row.id));
});

test('sparse local intersections preserve seeks from nonzero ordinal bases', async () => {
  const rows = Array.from({ length: 5000 }, (_, ordinal) => ({ id: idFor(ordinal), names: [] }));
  for (let index = 0; index < 36; index++) {
    const ordinal = 7 + index * 137;
    rows[ordinal].names = index % 3 === 1 ? [green] : [green, blue];
    rows[ordinal + 31].names = [blue];
    rows[ordinal + 32].names = [blue];
  }
  const { reader, options } = fixture(rows, 16);
  const expected = rows.filter(matches).map(row => row.id);
  assert.deepEqual(await remaining(reader, options), expected);
  assert.deepEqual(await remaining(reader, { ...options, text: 'lue ree', limit: 7 }), expected);
});

test('wide sparse chunks preserve full ordinals across descriptor transitions', async () => {
  const rows = Array.from({ length: 70050 }, (_, ordinal) => ({ id: idFor(ordinal), names: [] }));
  for (const ordinal of [31, 32, 65567, 65568, 70000]) rows[ordinal].names = [green, blue];
  rows[900].names = [green];
  const { reader, options } = fixture(rows, 4);
  const expected = rows.filter(matches).map(row => row.id);
  assert.deepEqual(await remaining(reader, { ...options, limit: 2 }), expected);
  const suffix = await reader.searchAfterRank({ ...options, limit: 5 }, {
    stage: 'substring', kind: 'all', id: idFor(65566),
  });
  assert.deepEqual(suffix.results.map(hit => hit.object.id), expected.filter(id => id > idFor(65566)));
});
