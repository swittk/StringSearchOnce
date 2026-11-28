# StringSearchOnce

An embedded Node.js substring search engine built on compressed, independently
retrievable inverted-index pages. Keep your original records in your own
storage; the index nominates IDs, then your fetch callback retrieves the current
records before ranking and filtering the results.

The runtime uses only Node's standard library. This is not a search server,
database driver, durable queue, or distributed indexing system.

## Use

Use Node.js 18.18.0 or later on the 18.x line, or Node.js 20.5.0 or later.
Build and test this branch with:

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

The same API is available from CommonJS. The synchronous builder retains the
input, posting map and completed pages. `buildPostingGenerationInWorker(rows,
options, signal?)` moves that build off the calling event loop; it still has the
array input/output memory contract. The calling thread sends selected fields in
acknowledged batches of up to 256 rows. Large name values can make a batch
expensive to send.

For a bounded build, stream documents in strictly ascending ASCII ID order and
persist each completed page:

```ts
import { buildPostingGenerationFromOrderedDocuments } from 'stringsearchonce';

const manifest = await buildPostingGenerationFromOrderedDocuments(
  readDocumentsInIdOrder(),
  {
    generation: 'catalog-v2',
    kinds: ['title'],
    scratchDirectory: temporaryDirectory,
    runBytes: 8 * 1024 * 1024,
    mergeFanIn: 4,
  },
  {
    async writePage(generation, kind, page, bytes) {
      await saveUnpublishedPage(generation, kind, page, bytes);
    },
  },
);
```

The builder buffers a bounded run of terms and ordinals, spills sorted runs into
its own temporary child directory, and merges a bounded number at a time.
`runBytes` accounts for posting arrays, term strings and their containers; it is
not a total process-memory limit. One source document is indivisible and can
exceed the target. Each sink write is awaited before more output is retained.
The builder removes its temporary child on success or failure. The caller owns
unpublished page cleanup and publishes the returned manifest only after success.
Use this function inside a caller-owned worker when the build must not share the
request event loop.

Keep `stringsearchonce` external when bundling an application. If you inline it,
place the packaged array-builder worker beside the bundle and match its module
format and extension. Use a `.js` ESM bundle with `stringSearchBuilderWorker.js`
or a `.cjs` CommonJS bundle with `stringSearchBuilderWorker.cjs`.

## Index and storage

A build creates an immutable manifest and five groups of compressed
`Uint8Array` pages:

| Page kind | Content |
| --- | --- |
| directory | Sparse upper term fences for lexicon pages |
| lexicon | Sorted terms with inline singleton ordinals or larger-list descriptor ranges |
| descriptors | Fixed-width posting-chunk locations and ordinal fences |
| postings | Sorted integer ordinals encoded as delta-varints |
| ids | ID lengths and ASCII bytes, addressed by ordinal |

Pages use raw DEFLATE compression. Use a unique generation identifier. Build
and store all pages. Construct a reader for the stored generation with the
intended reader options and call `await reader.open()` before making the
manifest visible. Opening reads only the sparse directory. Exact and multi-gram
lookups load the needed lexicon blocks; hot terms seek within independently
paged chunk descriptors instead of loading one large per-term directory. A term
that occurs in one document stores its ordinal directly in the lexicon, with no
posting chunk or descriptor. ID pages retain compact bytes and offsets; only
requested IDs become strings during search.

A `PostingReader` stays bound to one immutable generation. The default cache
layout uses 4 MiB for raw pages, 2 MiB for requested IDs, and 36 MiB shared by
the parsed lexicon, decoded chunks and pinned sparse directory. The directory
has a 32 MiB admission ceiling; its retained charge is reserved from the shared
pool. Supplying any byte-budget option retains independent page, chunk, ID
and lexicon budgets, with omitted values using 4, 4, 2 and 32 MiB respectively.
In that case, `maxLexiconBytes` bounds the directory plus parsed lexicon.
These are retained-cache estimates, not a total V8 heap or process-RSS limit:
active queries also pin the blocks and cursor state they use. Cold loads of the
same pages are shared within one reader. Reuse a reader across searches of the
same generation. The index does not cache source records or access decisions
across searches.

The `PostingPageStore` interface is the only storage boundary. It returns
binary bytes for the requested page numbers and generation. An adapter
chooses how to store them and transport them. The build does not require a
database, and the reader does not write to storage. An application can
publish replacement generations or combine readers with its own live
changes; the library does not provide a mutable index or background
publication lifecycle.

Source IDs are unique strings of 1 to 128 ASCII characters from `0x21`
through `0x7E`. The caller supplies the ordered nonempty name kinds. Default
matching lowercases NFC text and maps Greek final sigma (`ς`) to `σ`, retaining
accents and combining marks. `STRASSE` and `Straße` have different lookup keys.
Search uses Unicode code points. Build and read a generation with the same
Node.js Unicode data version (`process.versions.unicode`). Rebuild the
generation when changing Unicode versions.

## Search order and eligibility

The reader ranks exact names by kind, then whole-name prefixes by kind, then
all-word token-prefix matches, then interior substring matches. Within a tier,
source IDs sort in bytewise order. Words can match different names on the same
record. A query with one ordinary code point has prefix-only coverage.
The reader counts code points in the trimmed query after lowercasing and
normalization by default, or after NFC normalization alone in `caseSensitive`
mode. For example, `İ` can use substring coverage because it lowercases to two
code points. Standalone symbols can also use substring coverage. Queries
containing only multiple ordinary one-character words are not supported.

The fetch callback must enforce the caller's access rules and current source
filters and return at most one current record per requested ID. Deleted,
denied, and stale-name candidates are excluded before the
limit; the reader continues to later candidates when needed. Optional
`filterCandidates` can perform additional eligibility checks.
When a name-prefix expansion exceeds `maxMatchedTerms`, the reader can nominate
from complete word-prefix groups instead. If one word group exceeds the limit,
its whole incomplete expansion is discarded; the remaining complete groups
supply a candidate superset and current source names still verify every word.
A complete empty group proves that tier empty. If no complete group is
available, the request retains the matched-term error. Source and cursor work
limits still apply to every plan.

A changed name absent from the built snapshot cannot be discovered just by
rechecking the source rows. Rebuild or provide a live overlay at the application
layer.

Use `reader.searchPage` for signed keyset pagination. Supply the same
`scopeKey`, query and server-only `signingKey` on each page. Include
the actual caller identity, collection and filters in the scope. A different
generation, query or scope invalidates the cursor. Live name edits can move a
row across the cursor and cause skipped or repeated results. To restart on
such edits, include a source revision in `scopeKey` and start a new traversal
when the revision changes. `searchAfterRank` continues
after a rank and source-ID boundary for applications combining ranked streams.

## Multiple generations

Use `reader.idBatches()` to enumerate a generation's IDs in ascending order
using only ID pages. Batches are readonly.

```ts
for await (const ids of deltaReader.idBatches())
  for (const id of ids) affectedIds.add(id);

const page = await PostingReader.searchCompositePage([baseReader, deltaReader], {
  text, fetchSources, getId, getNames, scopeKey, signingKey, cursor,
  readLive: (after, limit) => findCurrentMatchesAfter(after, limit),
});
```

All readers must use the same ordered kinds. The optional live callback
returns a bounded prefix of distinct, eligible matches in the same rank/ID
order, strictly after the supplied boundary. Use the same current-record,
name ranking and access policies for every stream. Each page keeps the first
match per ID in rank order. Ties keep the first reader's result, with live
results last. The page reads at most one prefix of `limit + 1` hits per stream.
Reader work limits apply to each reader. Bound live work in `readLive`.

Pass `nextCursor` with the same ordered generations and kinds, query,
`caseSensitive` setting, `scopeKey`, signing key and live-stream presence.
Live edits can move a match across the cursor. Include a live revision in
`scopeKey` to restart traversal on such edits. The caller owns live nomination,
source reads and publication.

Source-fetch batches adapt to remaining result demand and the observed acceptance
rate within each rank tier. The caller's `batchSize` remains a ceiling. Rows fetched
beyond the required result and lookahead prefix are not ranked.

The reader has explicit limits for cache size, lexicon size, candidate reads,
and cursor work. Exceeding a limit throws rather than returning silently
truncated results. If multiple work limits are insufficient, batching can affect
which exhausted limit is reported first.

`POSTING_INDEX_COMPATIBILITY_VERSION` identifies the stored index contract:
page encoding plus persisted normalization, token and gram semantics. Its value
is `1` for the paged dictionary and descriptor layout. Applications can include
it in their own index fingerprints without rebuilding for unrelated package
releases. This format requires rebuilding derived indexes before switching
readers; it does not read format-0 pages. Keep the publication switch separate
from page construction, and do not point older readers at the replacement
manifest. Signed-cursor compatibility is tracked separately.

## Tests and benchmark

```sh
npm run check
npm run bench
# After building, choose a generated corpus size:
node bench/search.mjs 33000
```

The tests cover binary pages, Unicode ranking, current-record verification,
permissions supplied by the caller, signed pagination, cold/warm decoding
the bounded builder's spill/merge cleanup, lazy dictionary/descriptor reads
and both module formats' worker entrypoint. The benchmark uses a generated
catalog and an in-memory page store. Its latency measures the engine and
callback path, not network or real database latency. No comparative claims
about other engines are made.

MIT licensed.
