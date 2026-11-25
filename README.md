# StringSearchOnce

An embedded Node.js substring search engine built on compressed, independently
retrievable inverted-index pages. Keep your original records in your own
storage; the index nominates IDs, then your fetch callback retrieves the current
records before ranking and filtering the results.

The runtime uses only Node's standard library. This is not a search server,
database driver, durable queue, or distributed indexing system.

## Use

Node.js 22 or later. The initial implementation is under review; no npm
release has been made yet. Build and test this branch with:

```sh
npm ci
npm run check
```

```ts
import { buildPostingGeneration, PostingReader } from 'stringsearchonce';

const rows = [
  { id: '01', names: [{ kind: 'title', text: 'Blue wooden table' }] },
  { id: '02', names: [{ kind: 'title', text: 'โต๊ะไม้' }] },
  { id: '03', names: [{ kind: 'title', text: 'Folding table' }] },
];
const byId = new Map(rows.map(row => [row.id, row]));
const built = buildPostingGeneration(rows, {
  generation: 'catalog-v1',
  kinds: ['title'],
});

// An in-memory example. A persistent adapter can load just the requested pages.
const reader = new PostingReader(built.manifest, {
  async readPages(generation, kind, pages) {
    if (generation !== built.manifest.generation) throw Error('Unknown generation');
    const stored = built.pages.get(kind)!;
    return new Map(pages.map(page => [page, stored[page]!]));
  },
});

const result = await reader.search({
  text: 'table',
  limit: 10,
  fetchSources: async ids => ids.flatMap(id => byId.has(id) ? [byId.get(id)!] : []),
  getId: row => row.id,
  getNames: row => row.names,
});
console.log(result.results);
```

The same API is available from CommonJS. For a large build, use
`buildPostingGenerationInWorker(rows, options, signal?)` instead of the
synchronous builder. The worker is included in the package and constructs the
index off the calling thread. The calling thread copies and serializes the
selected fields in acknowledged batches of up to 256 rows. Large name values
can still make a batch expensive to send. When bundling the library into a
standalone application, retain the matching ESM or CJS packaged worker file
beside the compiled entrypoint or keep the library external.

## Index and storage

A build creates an immutable manifest and three groups of compressed
`Uint8Array` pages:

| Page kind | Content |
| --- | --- |
| lexicon | Sorted terms and pointers to posting chunks |
| postings | Sorted integer ordinals encoded as delta-varints |
| ids | Mapping from ordinals to the original IDs |

Pages use raw DEFLATE compression. Build and store all pages before making the
manifest visible to readers. Use a unique generation identifier. A
`PostingReader` stays bound to one generation. The reader opens the bounded
lexicon once, then retrieves posting/ID pages and decodes chunks lazily.
Page, chunk, and ID caches have separate byte budgets; cache counters report
cold reads and repeated decodes. The index does not cache source records or
access decisions across searches.

The `PostingPageStore` interface is the only storage boundary. It returns
binary bytes for the requested page numbers and generation. An adapter
chooses how to store them and transport them. The build does not require a
database, and the reader does not write to storage. An application can
publish replacement generations or combine readers with its own live
changes; the library does not provide a mutable index or background
publication lifecycle.

Source IDs are unique strings of 1 to 128 ASCII characters from `0x21`
through `0x7E`. Search terms are Unicode text. The caller supplies the ordered
nonempty name kinds. The index folds case with NFC normalization, retaining
accents and combining marks. Search uses Unicode code points.

## Search order and eligibility

The reader ranks exact names by kind, then whole-name prefixes by kind, then
all-word token-prefix matches, then interior substring matches. Within a tier,
source IDs sort in bytewise order. Words can match different names on the same
record. Ordinary one-character searches have prefix-only coverage, while
standalone symbols can use substring coverage. Queries containing only
multiple ordinary one-character words are not supported.

The fetch callback must enforce the caller's access rules and current source
filters. Deleted, denied, and stale-name candidates are excluded before the
limit; the reader continues to later candidates when needed. Optional
`filterCandidates` can perform additional eligibility checks.
A changed name absent from the built snapshot cannot be discovered just by
rechecking the source rows. Rebuild or provide a live overlay at the application
layer.

Use `reader.searchPage` for signed keyset pagination. Supply the same
`scopeKey`, query and server-only `signingKey` on each page. Include
the actual caller identity, collection and filters in the scope. A different
generation, query or scope invalidates the cursor. `searchAfterRank` continues
after a rank and source-ID boundary for applications combining ranked streams.

The reader has explicit limits for cache size, lexicon size, candidate reads,
and cursor work. Exceeding a limit throws rather than returning silently
truncated results. Format 0 is pre-release; do not assume compatibility with
future incompatible formats.

## Tests and benchmark

```sh
npm run check
npm run bench
# After building, choose a generated corpus size:
node bench/search.mjs 33000
```

The tests cover binary pages, Unicode ranking, current-record verification,
permissions supplied by the caller, signed pagination, cold/warm decoding
and both module formats' worker entrypoint. The benchmark uses a generated
catalog and an in-memory page store. Its latency measures the engine and
callback path, not network or real database latency. No comparative claims
about other engines are made.

MIT licensed.
