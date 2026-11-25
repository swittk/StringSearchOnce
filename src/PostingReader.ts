import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  comparePostingIds,
  decodePostingIds,
  foldPostingText,
  postingGrams,
  postingNameKey,
  unpackPostingPage,
  type PostingChunk,
  type PostingManifest,
  type PostingName,
  type PostingPageKind,
  type PostingPageStore,
  type PostingTerm,
} from './postingFormat';

/** The index supplies rank tiers; no source-object relevance sort runs during search. */
export type PostingStage = 'exact' | 'prefix' | 'word-prefix' | 'substring';
export type PostingTier = { stage: PostingStage; kind: string | 'all' };
/** Kind order is used by the frozen reader, live overlay and final merge. */
export function createPostingKindRanks(kinds: readonly string[]): Map<string, number> {
  const ranks = new Map<string, number>();
  for (const [rank, kind] of kinds.entries()) ranks.set(kind, rank);
  return ranks;
}

/** A single ordinary character only has exact and whole-name prefix tiers. */
export function createPostingTiers(kinds: readonly string[], prefixOnly = false): PostingTier[] {
  const tiers: PostingTier[] = [];
  for (const kind of kinds) tiers.push({ stage: 'exact', kind });
  for (const kind of kinds) tiers.push({ stage: 'prefix', kind });
  if (!prefixOnly) tiers.push({ stage: 'word-prefix', kind: 'all' }, { stage: 'substring', kind: 'all' });
  return tiers;
}

/** Convert a saved stage and kind into the same position used by the index cursors. */
export function postingTierRank(tier: PostingTier, kindRanks: ReadonlyMap<string, number>): number | undefined {
  if (tier.kind === 'all' && tier.stage === 'word-prefix') return kindRanks.size * 2;
  if (tier.kind === 'all' && tier.stage === 'substring') return kindRanks.size * 2 + 1;
  const rank = kindRanks.get(tier.kind);
  if (rank === undefined) return;
  if (tier.stage === 'exact') return rank;
  if (tier.stage === 'prefix') return kindRanks.size + rank;
}

/** The query's prepared text and kind order used to check actual source names. */
type PostingRankQuery = {
  /** Whole phrase used by the exact and name-prefix tiers. */
  phrase: string;
  /** Every word must match for word-prefix and substring tiers. */
  words: readonly string[];
  /** Whether source checks keep the caller's original capitalization. */
  caseSensitive?: boolean;
  /** Skip word-prefix and substring for ordinary one-character searches. */
  prefixOnly: boolean;
  /** Positions of the caller's allowed exact and prefix name kinds. */
  kindRanks: ReadonlyMap<string, number>;
};

/** Rank one source row once so a later tier cannot repeat a result from an earlier page. */
export function findBestPostingRank(names: readonly PostingName[], query: PostingRankQuery): number {
  const { phrase, words, caseSensitive, prefixOnly, kindRanks } = query;
  const nameTexts: string[] = [];
  let bestRank = Infinity;
  for (const name of names) {
    const text = caseSensitive ? name.text.normalize('NFC').trim() : foldPostingText(name.text);
    const kindRank = kindRanks.get(name.kind);
    if (kindRank !== undefined) {
      if (text === phrase) {
        if (kindRank === 0) return 0;
        bestRank = Math.min(bestRank, kindRank);
      } else if (text.startsWith(phrase)) {
        bestRank = Math.min(bestRank, kindRanks.size + kindRank);
      }
    }
    if (!prefixOnly && bestRank === Infinity) nameTexts.push(text);
  }
  if (prefixOnly || bestRank !== Infinity) return bestRank;

  // A query word can match any of the row's names. Split each name once.
  const tokens: string[] = [];
  for (const text of nameTexts) {
    for (const token of text.split(/\s+/u)) tokens.push(token);
  }
  let everyWordStartsAToken = true;
  for (const word of words) {
    if (tokens.some((token) => token.startsWith(word))) continue;
    everyWordStartsAToken = false;
    if (!nameTexts.some((text) => text.includes(word))) return Infinity;
  }
  return kindRanks.size * 2 + (everyWordStartsAToken ? 0 : 1);
}

/** The caller fetches current source rows under its own permissions and filters. */
export type PostingSearchOptions<T> = {
  text: string;
  fetchSources: (ids: readonly string[]) => Promise<readonly T[]>;
  getId: (object: T) => string;
  getNames: (object: T) => readonly PostingName[];
  filterCandidates?: (objects: readonly T[]) => Promise<readonly T[]>;
  caseSensitive?: boolean;
  limit?: number;
  batchSize?: number;
  maxSourceCandidates?: number;
  maxCursorSteps?: number;
};
/** The signed cursor binds the ordering, query and every caller-specific source filter. */
export type PostingPageOptions<T> = PostingSearchOptions<T> & {
  cursor?: string;
  /** Include the caller identity, collection and all source filters. */
  scopeKey: string;
  /** Server-only key, never returned to the client. */
  signingKey: string | Uint8Array;
};
export type PostingPageResult<T> = PostingSearchResult<T> & { nextCursor?: string };
export type PostingSearchResult<T> = {
  generation: string;
  coverage: 'substring' | 'prefix-only';
  results: Array<{ object: T; stage: PostingStage; kind: string }>;
  sourceReads: number;
  sourceCandidates: number;
  sourceRows: number;
  cursorSteps: number;
};
/** Cache budgets count retained buffers plus conservative string-array estimates, not total V8 RSS. */
export type PostingReaderOptions = {
  pageCacheBytes?: number;
  chunkCacheBytes?: number;
  idCacheBytes?: number;
  maxLexiconBytes?: number;
  maxMatchedTerms?: number;
};

/** One byte-bounded cache per generation. No source objects, session results or ACL decisions live here. */
class ByteCache<T> {
  private entries = new Map<string, { value: T; bytes: number }>();
  bytes = 0;
  constructor(readonly limit: number) {}
  get(key: string): T | undefined {
    const found = this.entries.get(key);
    if (!found) return undefined;
    this.entries.delete(key);
    this.entries.set(key, found);
    return found.value;
  }
  put(key: string, value: T, bytes: number): void {
    if (bytes > this.limit) return;
    const previous = this.entries.get(key);
    if (previous) {
      this.bytes -= previous.bytes;
      this.entries.delete(key);
    }
    while (this.bytes + bytes > this.limit) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.bytes -= this.entries.get(oldest)!.bytes;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { value, bytes });
    this.bytes += bytes;
  }
}

/** A cursor yields ordinals in increasing order; Infinity means there are no more. */
interface Cursor {
  peek(): number;
  seek(target: number): Promise<number>;
}
const emptyCursor = (): Cursor => ({ peek: () => Infinity, seek: async () => Infinity });

/** Skip whole chunks by their last ID before reading/decompressing any bytes. */
class ListCursor implements Cursor {
  private position = 0;
  private current: number;
  constructor(
    private chunks: readonly PostingChunk[],
    private load: (chunk: PostingChunk) => Promise<Uint32Array>,
    private tick: () => void
  ) {
    this.current = chunks[0]?.[4] ?? Infinity;
  }
  peek(): number {
    return this.current;
  }
  async seek(target: number): Promise<number> {
    if (this.current >= target) return this.current;
    this.tick();
    let lo = this.position,
      hi = this.chunks.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.chunks[mid]![5] < target) lo = mid + 1;
      else hi = mid;
    }
    this.position = lo;
    const chunk = this.chunks[lo];
    if (!chunk) return (this.current = Infinity);
    if (chunk[4] >= target) return (this.current = chunk[4]);
    const ids = await this.load(chunk);
    lo = 0;
    hi = ids.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (ids[mid]! < target) lo = mid + 1;
      else hi = mid;
    }
    return (this.current = ids[lo] ?? Infinity);
  }
}

/** Merge posting streams by ordinal. This heap never contains hydrated source objects. */
class UnionCursor implements Cursor {
  private heap: Cursor[];
  constructor(cursors: Cursor[], private tick: () => void) {
    this.heap = cursors.filter((cursor) => cursor.peek() !== Infinity);
    for (let i = (this.heap.length >>> 1) - 1; i >= 0; i--) this.down(i);
  }
  peek(): number {
    return this.heap[0]?.peek() ?? Infinity;
  }
  private down(start: number): void {
    let i = start;
    for (;;) {
      let child = i * 2 + 1;
      if (child >= this.heap.length) break;
      if (child + 1 < this.heap.length && this.heap[child + 1]!.peek() < this.heap[child]!.peek())
        child++;
      if (this.heap[i]!.peek() <= this.heap[child]!.peek()) break;
      [this.heap[i], this.heap[child]] = [this.heap[child]!, this.heap[i]!];
      i = child;
    }
  }
  async seek(target: number): Promise<number> {
    while (this.peek() < target) {
      this.tick();
      const cursor = this.heap[0]!;
      await cursor.seek(target);
      if (cursor.peek() === Infinity) {
        const last = this.heap.pop()!;
        if (this.heap.length) this.heap[0] = last;
      }
      if (this.heap.length) this.down(0);
    }
    return this.peek();
  }
}

/** Seek sorted intersections rather than creating a complete array of matching documents. */
class IntersectionCursor implements Cursor {
  private current = -1;
  constructor(private cursors: Cursor[], private tick: () => void) {}
  peek(): number {
    return this.current;
  }
  async seek(target: number): Promise<number> {
    if (this.current >= target) return this.current;
    if (!this.cursors.length) return (this.current = Infinity);
    let candidate = target;
    for (;;) {
      let changed = false;
      for (const cursor of this.cursors) {
        this.tick();
        const value = await cursor.seek(candidate);
        if (value === Infinity) return (this.current = Infinity);
        if (value > candidate) {
          candidate = value;
          changed = true;
        }
      }
      if (!changed) return (this.current = candidate);
    }
  }
}

/**
 * Read one immutable generation. The lexicon contains terms and page offsets,
 * not source objects. Live write/delete capture is deliberately not claimed here.
 */
export class PostingReader {
  private terms: string[] = [];
  private counts = new Uint32Array(0);
  private chunkOffsets = new Uint32Array(0);
  private chunkTable = new Uint32Array(0);
  private opened?: Promise<void>;
  private readonly pageCache: ByteCache<Uint8Array>;
  private readonly chunkCache: ByteCache<Uint32Array>;
  private readonly idCache: ByteCache<readonly string[]>;
  private readonly pendingPages = new Map<string, Promise<Uint8Array>>();
  private readonly pendingChunks = new Map<string, Promise<Uint32Array>>();
  readonly counters = {
    storeReads: 0,
    pagesRead: 0,
    pageDecodes: 0,
    chunkDecodes: 0,
    lexiconBytes: 0,
    lexiconEstimatedBytes: 0,
  };
  constructor(
    readonly manifest: PostingManifest,
    private store: PostingPageStore,
    private options: PostingReaderOptions = {}
  ) {
    const m = manifest;
    const lexiconLimit = options.maxLexiconBytes ?? 32 * 1048576;
    const termLimit = options.maxMatchedTerms ?? 20000;
    if (
      !Number.isSafeInteger(lexiconLimit) ||
      lexiconLimit < 1024 ||
      !Number.isSafeInteger(termLimit) ||
      termLimit < 1
    )
      throw new Error('POSTING_READER_LIMIT_INVALID');
    if (m.format !== 0 || typeof m.generation !== 'string' || !m.generation)
      throw new Error('POSTING_MANIFEST_INVALID');
    if (!Array.isArray(m.kinds) || !m.kinds.length)
      throw new Error('POSTING_MANIFEST_INVALID');
    if (m.kinds.some((kind) => typeof kind !== 'string' || !kind) || new Set(m.kinds).size !== m.kinds.length)
      throw new Error('POSTING_MANIFEST_INVALID');
    for (const count of [m.documents, m.terms, m.lexiconPages, m.postingPages, m.idPages, m.idsPerPage]) {
      if (!Number.isSafeInteger(count) || count < 0)
        throw new Error('POSTING_MANIFEST_INVALID');
    }
    if (m.documents > 0xffffffff || m.terms > Math.floor(lexiconLimit / 32))
      throw new Error('POSTING_MANIFEST_INVALID');
    if (m.lexiconPages > 65536 || m.postingPages > 1000000)
      throw new Error('POSTING_MANIFEST_INVALID');
    if (m.idsPerPage < 1 || m.idsPerPage > 4096)
      throw new Error('POSTING_MANIFEST_INVALID');
    if (m.idPages !== Math.ceil(m.documents / m.idsPerPage))
      throw new Error('POSTING_MANIFEST_INVALID');
    this.manifest = { ...m, kinds: [...m.kinds] };
    const budgets = [
      options.pageCacheBytes ?? 4 * 1048576,
      options.chunkCacheBytes ?? 4 * 1048576,
      options.idCacheBytes ?? 2 * 1048576,
    ];
    if (budgets.some((value) => !Number.isSafeInteger(value) || value < 0))
      throw new Error('POSTING_CACHE_LIMIT_INVALID');
    this.pageCache = new ByteCache(budgets[0]!);
    this.chunkCache = new ByteCache(budgets[1]!);
    this.idCache = new ByteCache(budgets[2]!);
  }
  /** Counters make cold loads and repeated Base64 decoding visible in benchmarks. */
  cacheUsage(): { pages: number; chunks: number; ids: number; limit: number } {
    return {
      pages: this.pageCache.bytes,
      chunks: this.chunkCache.bytes,
      ids: this.idCache.bytes,
      limit: this.pageCache.limit + this.chunkCache.limit + this.idCache.limit,
    };
  }
  /** Load the bounded term directory once for this generation, in batched storage reads. */
  async open(): Promise<void> {
    if (!this.opened)
      this.opened = this.loadLexicon().catch((error) => {
        this.opened = undefined;
        this.terms = [];
        throw error;
      });
    await this.opened;
  }
  private async loadLexicon(): Promise<void> {
    const terms: string[] = [];
    const counts = new Uint32Array(this.manifest.terms),
      offsets = new Uint32Array(this.manifest.terms + 1);
    let table = new Uint32Array(Math.max(6, this.manifest.terms * 6));
    let bytes = 0,
      stringBytes = 0,
      used = 0,
      previous = '';
    const maximum = this.options.maxLexiconBytes ?? 32 * 1048576;
    const retainedBytes = () =>
      stringBytes + counts.byteLength + offsets.byteLength + table.byteLength;
    if (retainedBytes() > maximum) throw new Error('POSTING_LEXICON_BUDGET_EXCEEDED');
    // Bound cold storage responses; the directory loads once per generation.
    const lexiconPageBatchSize = 4;
    for (let start = 0; start < this.manifest.lexiconPages; start += lexiconPageBatchSize) {
      const numbers = Array.from(
        { length: Math.min(lexiconPageBatchSize, this.manifest.lexiconPages - start) },
        (_, i) => start + i
      );
      this.counters.storeReads++;
      const pages = await this.store.readPages(this.manifest.generation, 'lexicon', numbers);
      this.counters.pagesRead += pages.size;
      for (const page of numbers) {
        const payload = pages.get(page);
        if (!payload) throw new Error('POSTING_LEXICON_PAGE_MISSING');
        const decoded = unpackPostingPage(payload, 262144);
        this.counters.pageDecodes++;
        bytes += decoded.byteLength;
        if (bytes > maximum) throw new Error('POSTING_LEXICON_BUDGET_EXCEEDED');
        const raw: unknown = JSON.parse(new TextDecoder().decode(decoded));
        if (!Array.isArray(raw)) throw new Error('POSTING_LEXICON_INVALID');
        for (const value of raw) {
          if (!Array.isArray(value) || value.length !== 3)
            throw new Error('POSTING_TERM_INVALID');
          const [term, count, chunks] = value;
          if (typeof term !== 'string' || term <= previous)
            throw new Error('POSTING_TERM_INVALID');
          if (!Number.isSafeInteger(count) || count < 1)
            throw new Error('POSTING_TERM_INVALID');
          if (!Array.isArray(chunks) || !chunks.length)
            throw new Error('POSTING_TERM_INVALID');
          if (terms.length >= this.manifest.terms)
            throw new Error('POSTING_LEXICON_COUNT_MISMATCH');
          offsets[terms.length] = used;
          let last = -1,
            total = 0;
          for (const chunk of chunks) {
            if (!Array.isArray(chunk) || chunk.length !== 6)
              throw new Error('POSTING_CHUNK_INVALID');
            for (const cell of chunk) {
              if (!Number.isSafeInteger(cell) || cell < 0)
                throw new Error('POSTING_CHUNK_INVALID');
            }
            const [pageNumber, byteOffset, byteLength, idCount, firstId, lastId] = chunk;
            if (pageNumber >= this.manifest.postingPages || byteLength < 1 || byteOffset + byteLength > 131072)
              throw new Error('POSTING_CHUNK_INVALID');
            if (idCount < 1 || idCount > 4096)
              throw new Error('POSTING_CHUNK_INVALID');
            if (firstId <= last || lastId < firstId || lastId >= this.manifest.documents)
              throw new Error('POSTING_CHUNK_INVALID');
            if (used + 6 > table.length) {
              if (retainedBytes() + table.byteLength > maximum)
                throw new Error('POSTING_LEXICON_BUDGET_EXCEEDED');
              const larger = new Uint32Array(table.length * 2);
              larger.set(table);
              table = larger;
            }
            for (let cell = 0; cell < 6; cell++) table[used++] = chunk[cell];
            last = lastId;
            total += idCount;
          }
          if (total !== count) throw new Error('POSTING_TERM_COUNT_MISMATCH');
          counts[terms.length] = count;
          terms.push(term);
          previous = term;
          stringBytes += 40 + term.length * 2;
          if (retainedBytes() > maximum) throw new Error('POSTING_LEXICON_BUDGET_EXCEEDED');
        }
      }
    }
    if (terms.length !== this.manifest.terms) throw new Error('POSTING_LEXICON_COUNT_MISMATCH');
    offsets[terms.length] = used;
    this.terms = terms;
    this.counts = counts;
    this.chunkOffsets = offsets;
    this.chunkTable = table.subarray(0, used);
    this.counters.lexiconBytes = bytes;
    this.counters.lexiconEstimatedBytes = retainedBytes();
  }
  private async readPage(kind: PostingPageKind, page: number): Promise<Uint8Array> {
    const key = kind + ':' + page;
    const hit = this.pageCache.get(key);
    if (hit) return hit;
    let pending = this.pendingPages.get(key);
    if (!pending) {
      pending = (async () => {
        this.counters.storeReads++;
        const pages = await this.store.readPages(this.manifest.generation, kind, [page]);
        this.counters.pagesRead += pages.size;
        const value = pages.get(page);
        if (!value) throw new Error('POSTING_PAGE_MISSING:' + kind + ':' + page);
        const decoded = unpackPostingPage(value, kind === 'ids' ? 1048576 : 131072);
        this.counters.pageDecodes++;
        this.pageCache.put(key, decoded, decoded.byteLength);
        return decoded;
      })().finally(() => this.pendingPages.delete(key));
      this.pendingPages.set(key, pending);
    }
    return pending;
  }
  private async readChunk(chunk: PostingChunk): Promise<Uint32Array> {
    const key = chunk[0] + ':' + chunk[1] + ':' + chunk[2];
    const hit = this.chunkCache.get(key);
    if (hit) return hit;
    let pending = this.pendingChunks.get(key);
    if (!pending) {
      pending = (async () => {
        const page = await this.readPage('postings', chunk[0]);
        if (chunk[1] + chunk[2] > page.byteLength) throw new Error('POSTING_CHUNK_OUTSIDE_PAGE');
        const decoded = decodePostingIds(
          page.subarray(chunk[1], chunk[1] + chunk[2]),
          chunk[3],
          this.manifest.documents
        );
        if (decoded[0] !== chunk[4] || decoded.at(-1) !== chunk[5])
          throw new Error('POSTING_CHUNK_BOUND_MISMATCH');
        this.counters.chunkDecodes++;
        this.chunkCache.put(key, decoded, decoded.byteLength);
        return decoded;
      })().finally(() => this.pendingChunks.delete(key));
      this.pendingChunks.set(key, pending);
    }
    return pending;
  }
  private lowerBound(term: string): number {
    let lo = 0,
      hi = this.terms.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.terms[mid]! < term) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  /** Materialize headers only for selected terms; the full directory uses packed integer buffers. */
  private termAt(index: number): PostingTerm {
    const chunks: PostingChunk[] = [];
    for (let at = this.chunkOffsets[index]!; at < this.chunkOffsets[index + 1]!; at += 6) {
      const t = this.chunkTable;
      chunks.push([t[at]!, t[at + 1]!, t[at + 2]!, t[at + 3]!, t[at + 4]!, t[at + 5]!]);
    }
    return [this.terms[index]!, this.counts[index]!, chunks];
  }
  private exact(term: string): readonly PostingTerm[] {
    const index = this.lowerBound(term);
    return this.terms[index] === term ? [this.termAt(index)] : [];
  }
  private prefix(term: string): readonly PostingTerm[] {
    const first = this.lowerBound(term);
    let end = first;
    while (end < this.terms.length && this.terms[end]!.startsWith(term)) end++;
    if (end - first > (this.options.maxMatchedTerms ?? 20000))
      throw new Error('POSTING_MATCHED_TERM_LIMIT');
    return Array.from({ length: end - first }, (_, offset) => this.termAt(first + offset));
  }
  private cursor(entries: readonly PostingTerm[], tick: () => void): Cursor {
    if (!entries.length) return emptyCursor();
    const lists = entries.map(
      (entry) => new ListCursor(entry[2], (chunk) => this.readChunk(chunk), tick)
    );
    return lists.length === 1 ? lists[0]! : new UnionCursor(lists, tick);
  }
  private async intersection(
    groups: readonly (readonly PostingTerm[])[],
    tick: () => void
  ): Promise<Cursor> {
    // Sort by the posting lengths once so the smallest group drives the intersection.
    const groupsBySize: { entries: readonly PostingTerm[]; size: number }[] = [];
    for (const entries of groups) {
      if (!entries.length) return emptyCursor();
      let size = 0;
      for (const entry of entries) size += entry[1];
      groupsBySize.push({ entries, size });
    }
    groupsBySize.sort((a, b) => a.size - b.size);
    const cursor = new IntersectionCursor(
      groupsBySize.map(({ entries }) => this.cursor(entries, tick)),
      tick
    );
    await cursor.seek(0);
    return cursor;
  }
  private async objectIds(ordinals: readonly number[]): Promise<string[]> {
    const pages = new Map<number, readonly string[]>();
    for (const ordinal of ordinals) {
      const number = Math.floor(ordinal / this.manifest.idsPerPage);
      if (pages.has(number)) continue;
      const key = String(number);
      let ids = this.idCache.get(key);
      if (!ids) {
        const raw: unknown = JSON.parse(
          new TextDecoder().decode(await this.readPage('ids', number))
        );
        const expected = Math.min(
          this.manifest.idsPerPage,
          this.manifest.documents - number * this.manifest.idsPerPage
        );
        if (!Array.isArray(raw) || raw.length !== expected)
          throw new Error('POSTING_OBJECT_IDS_INVALID');
        let size = 48;
        let previousId = '';
        for (const id of raw) {
          if (typeof id !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(id) || id <= previousId)
            throw new Error('POSTING_OBJECT_IDS_INVALID');
          previousId = id;
          size += 24 + id.length * 2;
        }
        ids = raw;
        this.idCache.put(key, ids, size);
      }
      pages.set(number, ids);
    }
    return ordinals.map(
      (ordinal) =>
        pages.get(Math.floor(ordinal / this.manifest.idsPerPage))![
          ordinal % this.manifest.idsPerPage
        ]!
    );
  }
  /**
   * Return successive pages in tier/objectId order. A token is scoped to this immutable
   * generation, search text and caller's source query; it cannot be edited to skip rows.
   * Rows edited between requests are reverified. An index generation change invalidates
   * the token rather than silently mixing two different posting orders.
   */
  async searchPage<T>(options: PostingPageOptions<T>): Promise<PostingPageResult<T>> {
    const { signingKey, scopeKey, cursor, ...request } = options;
    const limit = request.limit ?? 10;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error('POSTING_PAGE_OPTIONS_INVALID');
    if (typeof scopeKey !== 'string' || !scopeKey)
      throw new Error('POSTING_PAGE_OPTIONS_INVALID');
    if (typeof signingKey !== 'string' && !(signingKey instanceof Uint8Array))
      throw new Error('POSTING_PAGE_OPTIONS_INVALID');
    if (signingKey.length < 16)
      throw new Error('POSTING_PAGE_OPTIONS_INVALID');
    const digest = createHash('sha256')
      .update(
        JSON.stringify([
          this.manifest.generation,
          this.manifest.kinds,
          request.text.normalize('NFC'),
          Boolean(request.caseSensitive),
          scopeKey,
        ])
      )
      .digest('hex');
    let after: { tier: number; ordinal: number } | undefined;
    const sign = (payload: string) => createHmac('sha256', signingKey).update(payload).digest();
    if (cursor) {
      if (cursor.length > 4096) throw new Error('POSTING_CURSOR_INVALID');
      const pieces = cursor.split('.');
      if (pieces.length !== 2) throw new Error('POSTING_CURSOR_INVALID');
      const encoded = pieces[0]!,
        mac = pieces[1]!;
      const correct = sign(encoded);
      let provided: Buffer;
      try {
        provided = Buffer.from(mac, 'base64url');
      } catch {
        throw new Error('POSTING_CURSOR_INVALID');
      }
      if (
        provided.byteLength !== correct.byteLength ||
        !timingSafeEqual(
          new Uint8Array(provided.buffer, provided.byteOffset, provided.byteLength),
          new Uint8Array(correct.buffer, correct.byteOffset, correct.byteLength)
        )
      )
        throw new Error('POSTING_CURSOR_INVALID');
      let decoded: unknown;
      try {
        decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
      } catch {
        throw new Error('POSTING_CURSOR_INVALID');
      }
      if (!Array.isArray(decoded) || decoded.length !== 4)
        throw new Error('POSTING_CURSOR_INVALID');
      const [version, cursorDigest, tier, ordinal] = decoded;
      if (version !== 1 || cursorDigest !== digest)
        throw new Error('POSTING_CURSOR_INVALID');
      if (!Number.isSafeInteger(tier) || tier < 0)
        throw new Error('POSTING_CURSOR_INVALID');
      if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= this.manifest.documents)
        throw new Error('POSTING_CURSOR_INVALID');
      after = { tier, ordinal };
      if (after.tier >= this.manifest.kinds.length * 2 + 2)
        throw new Error('POSTING_CURSOR_INVALID');
    }
    // One extra accepted row proves there really is another page. Never count a
    // denied row or a stale-name false positive as proof that more results exist.
    const { result, positions } = await this.searchRun({ ...request, limit: limit + 1 }, after);
    if (result.results.length <= limit) return result;
    const last = positions[limit - 1]!;
    const payload = Buffer.from(JSON.stringify([1, digest, last.tier, last.ordinal])).toString(
      'base64url'
    );
    const nextCursor = payload + '.' + sign(payload).toString('base64url');
    return { ...result, results: result.results.slice(0, limit), nextCursor };
  }
  /** Search starts at the beginning when no paging cursor was provided. */
  async search<T>(options: PostingSearchOptions<T>): Promise<PostingSearchResult<T>> {
    return (await this.searchRun(options)).result;
  }
  /**
   * Continue from a global rank/ID pair. The ID may belong to a newer live
   * overlay and therefore not exist in this snapshot.
   * The composite live search owns the signed client cursor and permission scope.
   */
  async searchAfterRank<T>(
    options: PostingSearchOptions<T>,
    last?: { stage: PostingStage; kind: string; id: string }
  ): Promise<PostingSearchResult<T>> {
    if (!last) return this.search(options);
    const tier = postingTierRank(last, createPostingKindRanks(this.manifest.kinds));
    if (tier === undefined || !/^[\x21-\x7e]{1,128}$/.test(last.id))
      throw new Error('POSTING_RANK_CURSOR_INVALID');
    await this.open();
    // Search the sorted ordinal->ID mapping. The continuation object may have
    // been inserted after the frozen snapshot, so equality is not required.
    let low = 0,
      high = this.manifest.documents;
    while (low < high) {
      const mid = (low + high) >>> 1;
      const [id] = await this.objectIds([mid]);
      if (id! <= last.id) low = mid + 1;
      else high = mid;
    }
    return (await this.searchRun(options, { tier, ordinal: low - 1 })).result;
  }
  /** Find the ranked prefix of authorized matches, without fetching/sorting the entire candidate set. */
  private async searchRun<T>(
    options: PostingSearchOptions<T>,
    after?: { tier: number; ordinal: number }
  ): Promise<{
    result: PostingSearchResult<T>;
    positions: Array<{ tier: number; ordinal: number }>;
  }> {
    const {
      limit = 10,
      batchSize = 20,
      maxSourceCandidates = 10000,
      maxCursorSteps = 1000000,
    } = options;
    if (
      ![limit, batchSize, maxSourceCandidates, maxCursorSteps].every(
        (n) => Number.isSafeInteger(n) && n > 0
      ) ||
      batchSize > 100 ||
      limit > maxSourceCandidates
    )
      throw new Error('POSTING_QUERY_LIMITS');
    const folded = foldPostingText(options.text),
      words = folded.split(/\s+/u).filter(Boolean);
    const ordinarySingleCharacter =
      words.length === 1 && Array.from(words[0]!).length === 1 && !/^\p{S}$/u.test(words[0]!);
    const result: PostingSearchResult<T> = {
      generation: this.manifest.generation,
      coverage: ordinarySingleCharacter ? 'prefix-only' : 'substring',
      results: [],
      sourceReads: 0,
      sourceCandidates: 0,
      sourceRows: 0,
      cursorSteps: 0,
    };
    const positions: Array<{ tier: number; ordinal: number }> = [];
    if (!words.length) return { result, positions };
    if (options.text.length > 512 || words.length > 32) throw new Error('POSTING_QUERY_TOO_LONG');
    await this.open();
    const matchingPhrase = options.caseSensitive ? options.text.normalize('NFC').trim() : folded;
    const matchingWords = options.caseSensitive ? matchingPhrase.split(/\s+/u) : words;
    const tick = () => {
      if (++result.cursorSteps > maxCursorSteps) throw new Error('POSTING_CURSOR_LIMIT');
    };
    // Retain each fetched row and its verified best rank only for this search.
    const sourceRows = new Map<number, { object: T; rank: number } | null>();
    const accepted = new Set<number>();
    const gramTerms = new Set<string>();
    for (const word of words) {
      const count = Array.from(word).length;
      if (count >= 2) {
        for (const gram of postingGrams(word, Math.min(3, count))) gramTerms.add(gram);
      } else if (/^\p{S}$/u.test(word)) gramTerms.add('g1|' + word);
    }
    if (words.length > 1 && !gramTerms.size) throw new Error('POSTING_QUERY_TOO_SHORT');
    const tiers = createPostingTiers(this.manifest.kinds, ordinarySingleCharacter);
    const rankQuery: PostingRankQuery = {
      phrase: matchingPhrase,
      words: matchingWords,
      caseSensitive: options.caseSensitive,
      prefixOnly: ordinarySingleCharacter,
      kindRanks: createPostingKindRanks(this.manifest.kinds),
    };
    for (const [tierNumber, tier] of tiers.entries()) {
      if (result.results.length >= limit) break;
      if (after && tierNumber < after.tier) continue;
      let cursor: Cursor;
      if (tier.stage === 'exact') {
        cursor = this.cursor(this.exact(postingNameKey(tier.kind, folded)), tick);
      } else if (tier.stage === 'prefix') {
        cursor = this.cursor(this.prefix(postingNameKey(tier.kind, folded)), tick);
      } else if (tier.stage === 'word-prefix') {
        cursor = await this.intersection(words.map((word) => this.prefix('w|' + word)), tick);
      } else {
        cursor = await this.intersection(Array.from(gramTerms, (term) => this.exact(term)), tick);
      }
      if (after && tierNumber === after.tier) await cursor.seek(after.ordinal + 1);
      while (cursor.peek() !== Infinity && result.results.length < limit) {
        const candidates: number[] = [];
        const size = Math.min(batchSize, limit - result.results.length);
        while (cursor.peek() !== Infinity && candidates.length < size) {
          tick();
          const ordinal = cursor.peek();
          await cursor.seek(ordinal + 1);
          if (!accepted.has(ordinal) && sourceRows.get(ordinal) !== null) candidates.push(ordinal);
        }
        if (!candidates.length) continue;
        const missing = candidates.filter((ordinal) => !sourceRows.has(ordinal));
        if (missing.length) {
          result.sourceCandidates += missing.length;
          if (result.sourceCandidates > maxSourceCandidates)
            throw new Error('POSTING_SOURCE_CANDIDATE_LIMIT');
          const ids = await this.objectIds(missing),
            allowedIds = new Set(ids);
          result.sourceReads++;
          const fetched = await options.fetchSources(ids);
          result.sourceRows += fetched.length;
          // Check requested IDs before calling the caller's extra eligibility filter.
          const fetchedById = new Map<string, T>();
          for (const object of fetched) {
            const id = options.getId(object);
            if (!allowedIds.has(id)) throw new Error('POSTING_SOURCE_OUTSIDE_REQUEST');
            fetchedById.set(id, object);
          }
          const allowed = options.filterCandidates
            ? new Set((await options.filterCandidates(fetched)).map(options.getId))
            : allowedIds;
          for (const [index, ordinal] of missing.entries()) {
            const id = ids[index]!;
            const object = fetchedById.get(id);
            sourceRows.set(ordinal, object && allowed.has(id)
              ? { object, rank: findBestPostingRank(options.getNames(object), rankQuery) }
              : null);
          }
        }
        for (const ordinal of candidates) {
          const source = sourceRows.get(ordinal);
          if (!source || source.rank !== tierNumber) continue;
          accepted.add(ordinal);
          result.results.push({ object: source.object, stage: tier.stage, kind: tier.kind });
          positions.push({ tier: tierNumber, ordinal });
        }
      }
    }
    return { result, positions };
  }
}
