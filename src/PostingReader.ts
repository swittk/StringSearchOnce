import { compactPostingChunk, copyPostingChunkRange, countPostingChunkRange, postingChunkOrdinal, postingChunkOrdinals, seekPostingChunk, type PostingChunkValues } from './postingChunkValues';
import { decodePostingObjectIds, postingObjectIdAt, type PostingObjectIdPage } from './postingObjectIds';
import {
  cachePostingObjectId, cachedPostingObjectId, postingObjectIdBlockBytes, postingObjectIdBlockSize,
  type PostingObjectIdBlock,
} from './postingObjectIdCache';
import {
  POSTING_INDEX_COMPATIBILITY_VERSION, postingDescriptorAt as descriptorAt,
  comparePostingIds, decodePostingIds, foldPostingText, postingGrams,
  postingNameKey, unpackPostingPage,
  type PostingManifest, type PostingPageKind, type PostingPageStore,
  type PostingTerm, type PostingDirectoryEntry as DirectoryEntry,
  type PostingChunk, type PostingName,
} from './postingFormat';
import { postingCursorDigest, readPostingCursor, writePostingCursor } from './postingCursor';
import { caseSensitivePostingPrefix, lowercasePostingText } from './postingText';
import { maxPostingPages } from './postingLimits';

function isDirectoryEntry(value: unknown): value is DirectoryEntry {
  return Array.isArray(value) && value.length === 2 &&
    typeof value[0] === 'string' && typeof value[1] === 'number';
}
function isPostingTerm(value: unknown): value is PostingTerm {
  if (!Array.isArray(value) || (value.length !== 2 && value.length !== 6) ||
      typeof value[0] !== 'string') return false;
  for (let field = 1; field < value.length; field++)
    if (!Number.isSafeInteger(value[field]) || value[field] < 0) return false;
  return true;
}

// A failed shared read must not release a request while its other callbacks run.
function completeReads<T>(reads: readonly Promise<T>[]): Promise<T[]> {
  return Promise.all(reads).catch(async (error: unknown) => {
    await Promise.allSettled(reads);
    throw error;
  });
}

const ordinaryPostingCharacter = /^[^\p{S}]$/u;

function checkPostingQueryLength(text: string): void {
  if (text.length > 512) throw new Error('POSTING_QUERY_TOO_LONG');
}

/** The index supplies rank tiers; no source-object relevance sort runs during search. */
export type PostingStage = 'exact' | 'prefix' | 'word-prefix' | 'substring';
export type PostingTier = { stage: PostingStage; kind: string | 'all' };
export type PostingRankBoundary = PostingTier & { id: string };
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
  /** Source-fetch ceiling; batches adapt to remaining demand and observed acceptance. */
  batchSize?: number;
  maxSourceCandidates?: number;
  maxCursorSteps?: number;
};

function postingQueryLimits({
  limit = 10,
  batchSize = 20,
  maxSourceCandidates = 10000,
  maxCursorSteps = 1000000,
}: Pick<PostingSearchOptions<unknown>, 'limit' | 'batchSize' | 'maxSourceCandidates' | 'maxCursorSteps'>) {
  const limits = [limit, batchSize, maxSourceCandidates, maxCursorSteps] as const;
  if (
    !limits.every((n) => Number.isSafeInteger(n) && n > 0) ||
    batchSize > 100 ||
    limit > maxSourceCandidates
  )
    throw new Error('POSTING_QUERY_LIMITS');
  return limits;
}

/** The signed cursor binds the ordering, query and every caller-specific source filter. */
export type PostingPageOptions<T> = PostingSearchOptions<T> & {
  cursor?: string;
  /** Include the caller identity, collection and all source filters. */
  scopeKey: string;
  /** Server-only key, never returned to the client. */
  signingKey: string | Uint8Array;
};
export type PostingPageResult<T> = PostingSearchResult<T> & { nextCursor?: string };
export type PostingCompositePageOptions<T> = PostingPageOptions<T> & {
  /**
   * Return up to limit distinct results in rank/ID order, strictly after the
   * boundary. Apply the same current-record, ranking and eligibility policies
   * as the readers. A shorter prefix signals exhaustion.
   */
  readLive?: (
    after: PostingRankBoundary | undefined, limit: number
  ) => Promise<readonly PostingHit<T>[]>;
};
export type PostingCompositePageResult<T> = Omit<PostingPageResult<T>, 'generation'> & {
  /** Number of ranked rows returned by readLive, before merge. Other counters sum the readers. */
  liveRows: number;
};
type PostingHit<T> = { object: T; stage: PostingStage; kind: string };
type PostingRankedPrefix<T> = {
  results: readonly PostingHit<T>[];
  rankAt: (index: number) => number;
};
export type PostingSearchResult<T> = {
  generation: string;
  coverage: 'substring' | 'prefix-only';
  results: PostingHit<T>[];
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

function mergePostingPrefixes<T>(
  streams: readonly PostingRankedPrefix<T>[],
  getId: (object: T) => string,
  limit: number
): PostingHit<T>[] {
  const heads = streams.map(({ results, rankAt }) => ({ results, rankAt, index: -1, rank: Infinity, id: '' }));
  const advance = (head: (typeof heads)[number]) => {
    const hit = head.results[++head.index];
    head.rank = hit ? head.rankAt(head.index) : Infinity;
    head.id = hit ? getId(hit.object) : '';
  };
  for (const head of heads) advance(head);
  const results: PostingHit<T>[] = [];
  const emitted = new Set<string>();
  while (results.length < limit) {
    let first: (typeof heads)[number] | undefined;
    for (const head of heads) {
      if (head.rank === Infinity) continue;
      if (
        !first || head.rank < first.rank ||
        (head.rank === first.rank && comparePostingIds(head.id, first.id) < 0)
      )
        first = head;
    }
    if (!first) break;
    const { rank, id } = first;
    // A source edit between reads can put an already emitted ID in a later tier.
    if (!emitted.has(id)) {
      emitted.add(id);
      results.push(first.results[first.index]!);
    }
    for (const head of heads) {
      if (head.rank === rank && head.id === id) advance(head);
    }
  }
  return results;
}

/** Each value belongs to one typed cache and one shared recency budget. */
interface CacheLink {
  key: string | number;
  bytes: number;
  owner: { evict(key: string | number, bytes: number): void };
  older: CacheLink | undefined;
  newer: CacheLink | undefined;
}
interface CacheEntry<T> extends CacheLink {
  value: T;
}

/** One byte limit and recency order, optionally shared by several cache kinds. */
class CacheBudget {
  private oldest: CacheLink | undefined;
  private newest: CacheLink | undefined;
  bytes = 0;
  constructor(public limit: number) {}
  private unlink(entry: CacheLink): void {
    if (entry.older) entry.older.newer = entry.newer;
    else this.oldest = entry.newer;
    if (entry.newer) entry.newer.older = entry.older;
    else this.newest = entry.older;
  }
  private append(entry: CacheLink): void {
    entry.older = this.newest;
    entry.newer = undefined;
    if (this.newest) this.newest.newer = entry;
    else this.oldest = entry;
    this.newest = entry;
  }
  resize(limit: number): void {
    this.limit = limit;
    while (this.bytes > limit) this.remove(this.oldest!);
  }
  touch(entry: CacheLink): void {
    if (entry !== this.newest) {
      this.unlink(entry);
      this.append(entry);
    }
  }
  remove(entry: CacheLink): void {
    this.unlink(entry);
    this.bytes -= entry.bytes;
    entry.owner.evict(entry.key, entry.bytes);
  }
  add(entry: CacheLink): void {
    while (this.bytes + entry.bytes > this.limit) this.remove(this.oldest!);
    this.append(entry);
    this.bytes += entry.bytes;
  }
}

type PostingCachedPage = Uint8Array | PostingObjectIdPage;
function postingCachedPageBytes(page: PostingCachedPage): Uint8Array {
  if (page instanceof Uint8Array) return page;
  const { bytes } = page;
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Byte-bounded generation data; cache hits update links without reinserting Map keys. */
class ByteCache<T> {
  private entries = new Map<string | number, CacheEntry<T>>();
  bytes = 0;
  constructor(readonly limit: number, private budget = new CacheBudget(limit)) {}
  has(key: string | number): boolean {
    return this.entries.has(key);
  }
  get(key: string | number): T | undefined {
    const found = this.entries.get(key);
    if (!found) return undefined;
    this.budget.touch(found);
    return found.value;
  }
  evict(key: string | number, bytes: number): void {
    this.entries.delete(key);
    this.bytes -= bytes;
  }
  put(key: string | number, value: T, bytes: number): void {
    if (bytes > this.limit || bytes > this.budget.limit) return;
    const previous = this.entries.get(key);
    if (previous) this.budget.remove(previous);
    const entry: CacheEntry<T> = { key, value, bytes, owner: this, older: undefined, newer: undefined };
    this.entries.set(key, entry);
    this.bytes += bytes;
    this.budget.add(entry);
  }
}

/** A cursor yields ordinals in increasing order; Infinity means there are no more. */
interface Cursor {
  peek(): number;
  seek(target: number): number | Promise<number>;
}
const emptyCursor = (): Cursor => ({ peek: () => Infinity, seek: async () => Infinity });

/** Locate the first ordinal at or after target in a sorted decoded chunk. */
function postingOrdinalLowerBound(values: Uint32Array, target: number): number {
  let lo = 0, hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Same ordinal-fence seek, with bounded descriptor pages instead of a materialized hot list. */
class ListCursor implements Cursor {
  private position = 0;
  private current: number;
  private currentHeader?: PostingChunk;
  private retainCurrent = false;
  private residentIds?: PostingChunkValues;
  private residentOffset = 0;
  private residentBitmap = false;
  private residentBase = 0;
  constructor(
    private term: PostingTerm,
    private header: (index: number) => PostingChunk | Promise<PostingChunk>,
    private load: (chunk: PostingChunk) => PostingChunkValues | Promise<PostingChunkValues>,
    private tick: () => void
  ) {
    this.current = term.length === 2 ? term[1] : term[4];
  }
  retainCurrentChunk(): void {
    this.retainCurrent = true;
  }
  clearCurrentChunk(): void {
    this.residentIds = undefined;
    this.residentOffset = 0;
  }
  private loadCurrentChunk(chunk: PostingChunk): PostingChunkValues | Promise<PostingChunkValues> {
    if (!this.retainCurrent || chunk !== this.currentHeader) return this.load(chunk);
    if (this.residentIds) return this.residentIds;
    const loaded = this.load(chunk);
    if (loaded instanceof Promise) return this.retainPendingChunk(chunk, loaded);
    this.setCurrentChunk(chunk, loaded);
    return loaded;
  }
  private async retainPendingChunk(chunk: PostingChunk, pending: Promise<PostingChunkValues>): Promise<PostingChunkValues> {
    const ids = await pending;
    if (this.currentHeader === chunk) this.setCurrentChunk(chunk, ids);
    return ids;
  }
  private setCurrentChunk(chunk: PostingChunk, ids: PostingChunkValues): void {
    this.residentIds = ids;
    this.residentBitmap = ids.length < chunk[3];
    this.residentBase = this.residentBitmap || ids instanceof Uint16Array ? chunk[4] : 0;
  }
  peek(): number { return this.current; }
  /** Known chunk data can advance without creating another promise or cache lookup. */
  seekLocal(target: number): number | Promise<number> {
    if (this.current >= target) return this.current;
    const ids = this.residentIds;
    if (!ids || this.currentHeader![5] < target) return this.seek(target);
    this.tick();
    const chunk = this.currentHeader!;
    if (this.residentBitmap) {
      const offset = target - this.residentBase;
      if (ids[offset >>> 5]! & (1 << (offset & 31))) {
        this.residentOffset = offset;
        return (this.current = target);
      }
    } else {
      const next = this.residentOffset + 1;
      const ordinal = ids[next]! + this.residentBase;
      if (ordinal >= target) {
        this.residentOffset = next;
        return (this.current = ordinal);
      }
    }
    this.residentOffset = seekPostingChunk(ids, chunk, target, this.residentOffset + 1);
    return (this.current = postingChunkOrdinal(ids, chunk, this.residentOffset));
  }
  seek(target: number): number | Promise<number> {
    if (this.current >= target) return this.current;
    this.tick();
    if (this.term.length === 2 || target > this.term[5]) {
      if (this.retainCurrent) this.clearCurrentChunk();
      return (this.current = Infinity);
    }
    const chunk = this.currentHeader;
    if (chunk && chunk[5] >= target) return this.seekCurrentChunk(target, chunk);
    if (this.retainCurrent) this.clearCurrentChunk();
    const lo = this.position, hi = this.term[3];
    if (chunk && lo + 1 < hi) {
      const next = this.header(lo + 1);
      return next instanceof Promise
        ? this.seekPendingNextHeader(target, lo + 1, hi, next)
        : this.seekAfterNextHeader(target, lo + 1, hi, next);
    }
    return this.seekHeaders(target, chunk ? lo + 1 : lo, hi);
  }
  private async seekPendingNextHeader(target: number, index: number, end: number, pending: Promise<PostingChunk>): Promise<number> {
    return this.seekAfterNextHeader(target, index, end, await pending);
  }
  private seekAfterNextHeader(target: number, index: number, end: number, chunk: PostingChunk): number | Promise<number> {
    if (chunk[5] < target) return this.seekHeaders(target, index + 1, end);
    this.position = index;
    this.currentHeader = chunk;
    return this.seekCurrentChunk(target, chunk);
  }
  /** Stay synchronous while descriptors are resident; resume only an actual page read. */
  private seekHeaders(target: number, lo: number, hi: number, winning?: PostingChunk): number | Promise<number> {
    while (lo < hi) {
      const mid = lo + Math.floor((hi - lo) / 2);
      const located = this.header(mid);
      if (located instanceof Promise) return this.seekPendingHeader(target, lo, hi, winning, located);
      if (located[5] < target) lo = mid + 1;
      else {
        hi = mid;
        winning = located;
      }
    }
    this.position = lo;
    if (lo >= this.term[3]!) return (this.current = Infinity);
    this.currentHeader = winning!;
    return this.seekCurrentChunk(target, winning!);
  }
  private async seekPendingHeader(
    target: number, lo: number, hi: number, winning: PostingChunk | undefined, pending: Promise<PostingChunk>
  ): Promise<number> {
    const header = await pending;
    const mid = lo + Math.floor((hi - lo) / 2);
    return header[5] < target
      ? this.seekHeaders(target, mid + 1, hi, winning)
      : this.seekHeaders(target, lo, mid, header);
  }
  private seekCurrentChunk(target: number, chunk: PostingChunk): number | Promise<number> {
    if (chunk[4] >= target) return (this.current = chunk[4]);
    const loaded = this.retainCurrent ? this.loadCurrentChunk(chunk) : this.load(chunk);
    return loaded instanceof Promise
      ? this.seekPendingChunk(target, chunk, loaded)
      : this.seekLoadedChunk(target, chunk, loaded);
  }
  private async seekPendingChunk(target: number, chunk: PostingChunk, pending: Promise<PostingChunkValues>): Promise<number> {
    return this.seekLoadedChunk(target, chunk, await pending);
  }
  private seekLoadedChunk(target: number, chunk: PostingChunk, ids: PostingChunkValues): number {
    const position = seekPostingChunk(ids, chunk, target, this.retainCurrent ? this.residentOffset : 0);
    if (this.retainCurrent) this.residentOffset = position;
    return (this.current = postingChunkOrdinal(ids, chunk, position));
  }
  async membershipWindow(target: number): Promise<{ values: Uint32Array; upper: number } | undefined> {
    const first = await this.seek(target);
    if (first === Infinity) return undefined;
    this.tick();
    if (this.term.length === 2) return { values: Uint32Array.of(first), upper: first };
    let chunk = this.currentHeader;
    if (!chunk) {
      const located = this.header(this.position);
      chunk = located instanceof Promise ? await located : located;
      this.currentHeader = chunk;
    }
    const loaded = this.loadCurrentChunk(chunk);
    const values = postingChunkOrdinals(loaded instanceof Promise ? await loaded : loaded, chunk, first);
    return { values, upper: chunk[5] };
  }
  /** Stop counting as soon as this list cannot improve the current local candidate set. */
  async smallerMembershipWindow(lower: number, upper: number, bestCount: number): Promise<Uint32Array | undefined> {
    this.tick();
    const first = await this.seek(lower);
    if (first > upper) return new Uint32Array(0);
    if (bestCount <= 1) return undefined;
    if (this.term.length === 2) return Uint32Array.of(first);
    let count = 0, buffer: Uint32Array | undefined;
    for (let index = this.position; index < this.term[3]; index++) {
      this.tick();
      const located = index === this.position && this.currentHeader ? this.currentHeader : this.header(index);
      const header = located instanceof Promise ? await located : located;
      if (header[4] > upper) break;
      let values: PostingChunkValues | undefined, length = header[3];
      if (header[4] < lower || header[5] > upper) {
        const loaded = this.loadCurrentChunk(header);
        values = loaded instanceof Promise ? await loaded : loaded;
        length = countPostingChunkRange(values, header, lower, upper, bestCount - count);
      }
      if (count + length >= bestCount) return undefined;
      if (length) {
        if (!values) {
          const loaded = this.loadCurrentChunk(header);
          values = loaded instanceof Promise ? await loaded : loaded;
        }
        buffer ??= new Uint32Array(bestCount - 1);
        copyPostingChunkRange(values, header, lower, upper, buffer, count);
        count += length;
      }
      if (header[5] >= upper) break;
    }
    return buffer ? buffer.subarray(0, count) : new Uint32Array(0);
  }
}

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

/** Intersect singleton term groups within one bounded anchor chunk at a time. */
class LocalMembershipIntersectionCursor implements Cursor {
  private current = -1;
  private values: Uint32Array = new Uint32Array(0);
  private position = 0;
  private upper = -1;
  private nextTarget = 0;
  private driver = 0;
  constructor(private cursors: ListCursor[], private tick: () => void) {
    for (const cursor of cursors) cursor.retainCurrentChunk();
  }
  private exhaust(): number {
    for (const cursor of this.cursors) cursor.clearCurrentChunk();
    return (this.current = Infinity);
  }
  peek(): number { return this.current; }
  seek(target: number): number | Promise<number> {
    const located = this.seekBuffered(target);
    return typeof located === 'number' ? located : this.resumeSeek(target, located);
  }
  private seekBuffered(target: number): number | Promise<number | undefined> {
    if (this.current >= target) return this.current;
    while (this.position < this.values.length) {
      const candidate = this.values[this.position++]!;
      if (candidate < target) continue;
      this.tick();
      const located = this.probeCandidate(candidate, 0);
      if (located !== undefined) return located;
    }
    return this.prepareWindow(target);
  }
  private async resumeSeek(target: number, pending: Promise<number | undefined>): Promise<number> {
    let value = await pending;
    while (value === undefined) {
      const located = this.seekBuffered(target);
      value = typeof located === 'number' ? located : await located;
    }
    return value;
  }
  /** Buffered candidates need no promise unless a probe actually reads another page. */
  private probeCandidate(candidate: number, from: number): number | undefined | Promise<number | undefined> {
    for (let index = from; index < this.cursors.length; index++) {
      if (index === this.driver) continue;
      this.tick();
      const located = this.cursors[index]!.seekLocal(candidate);
      if (located instanceof Promise) return this.resumeProbe(candidate, index + 1, located);
      if (located === Infinity) return this.exhaust();
      if (this.rejectCandidate(candidate, located)) return undefined;
    }
    return (this.current = candidate);
  }
  private resumeProbe(candidate: number, next: number, pending: Promise<number>): Promise<number | undefined> {
    return pending.then((value) => {
      if (value === Infinity) return this.exhaust();
      return this.rejectCandidate(candidate, value) ? undefined : this.probeCandidate(candidate, next);
    });
  }
  private rejectCandidate(candidate: number, value: number): boolean {
    if (value <= candidate) return false;
    if (value > this.upper) {
      this.position = this.values.length;
      this.nextTarget = Math.max(this.nextTarget, value);
    } else {
      while (this.position < this.values.length && this.values[this.position]! < value) {
        this.tick();
        this.position++;
      }
    }
    return true;
  }
  private async prepareWindow(target: number): Promise<number | undefined> {
    let lower = Math.max(target, this.nextTarget);
    for (;;) {
      this.values = new Uint32Array(0);
      this.position = 0;
      lower = Math.max(lower, target, this.nextTarget);
      this.tick();
      const known = this.cursors[0]!.peek();
      if (known >= lower) {
        let same = true;
        for (let index = 1; index < this.cursors.length; index++) {
          this.tick();
          if (this.cursors[index]!.peek() !== known) {
            same = false;
            break;
          }
        }
        if (same) {
          this.nextTarget = known + 1;
          return known === Infinity ? this.exhaust() : (this.current = known);
        }
      }
      // Each current peer position is a lower bound on any remaining match.
      for (let index = 1; index < this.cursors.length; index++) {
        const current = this.cursors[index]!.peek();
        if (current === Infinity) return this.exhaust();
        if (current > lower) lower = current;
      }
      let window = await this.cursors[0]!.membershipWindow(lower);
      if (!window) return this.exhaust();
      let values = window.values;
      this.upper = window.upper;
      this.nextTarget = this.upper + 1;
      window = undefined;
      lower = values[0]!;
      for (let index = 1; index < this.cursors.length; index++) {
        this.tick();
        const located = this.cursors[index]!.seekLocal(lower);
        const value = located instanceof Promise ? await located : located;
        if (value === Infinity) return this.exhaust();
        if (value > lower) lower = value;
      }
      if (lower > this.upper) continue;
      values = values.subarray(postingOrdinalLowerBound(values, lower));
      this.driver = 0;
      for (let index = 1; index < this.cursors.length; index++) {
        const smaller = await this.cursors[index]!.smallerMembershipWindow(lower, this.upper, values.length);
        if (smaller) {
          values = smaller;
          this.driver = index;
          if (!values.length) break;
        }
      }
      this.values = values;
      return undefined;
    }
  }
}

/**
 * Read one immutable generation. The lexicon contains terms and page offsets,
 * not source objects. Live write/delete capture is deliberately not claimed here.
 */
export class PostingReader {
  private directory: DirectoryEntry[] = [];
  private lexiconCache: ByteCache<readonly PostingTerm[]>;
  private readonly pendingLexicon = new Map<number, Promise<readonly PostingTerm[]>>();
  private opened?: Promise<void>;
  private readonly pageCache: ByteCache<PostingCachedPage>;
  private readonly chunkCache: ByteCache<PostingChunkValues>;
  private readonly idCache: ByteCache<PostingObjectIdBlock>;
  private readonly cacheLimit: number;
  private readonly decodedCacheBudget?: CacheBudget;
  private matchedTermLimitError: Error | undefined;
  private readonly pendingPages = new Map<string, Promise<Uint8Array>>();
  private readonly pendingChunks = new Map<number, Promise<PostingChunkValues>>();
  readonly counters = {
    storeReads: 0,
    pagesRead: 0,
    pageDecodes: 0,
    chunkDecodes: 0,
    lexiconBytes: 0,
    lexiconEstimatedBytes: 0,
    directoryBytes: 0,
    directoryEstimatedBytes: 0,
    cursorSteps: 0,
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
    if (
      m.format !== POSTING_INDEX_COMPATIBILITY_VERSION ||
      typeof m.generation !== 'string' || !m.generation
    )
      throw new Error('POSTING_MANIFEST_INVALID');
    if (!Array.isArray(m.kinds) || !m.kinds.length)
      throw new Error('POSTING_MANIFEST_INVALID');
    if (m.kinds.some((kind) => typeof kind !== 'string' || !kind) || new Set(m.kinds).size !== m.kinds.length)
      throw new Error('POSTING_MANIFEST_INVALID');
    for (const count of [m.documents, m.terms, m.directoryPages, m.lexiconPages, m.descriptorPages, m.postingPages, m.idPages, m.idsPerPage, m.descriptorsPerPage]) {
      if (!Number.isSafeInteger(count) || count < 0)
        throw new Error('POSTING_MANIFEST_INVALID');
    }
    if (m.documents > 0xffffffff)
      throw new Error('POSTING_MANIFEST_INVALID');
    if (m.postingPages > maxPostingPages || m.descriptorsPerPage < 1)
      throw new Error('POSTING_MANIFEST_INVALID');
    if (m.idsPerPage < 1 || m.idsPerPage > 4096)
      throw new Error('POSTING_MANIFEST_INVALID');
    if (m.idPages !== Math.ceil(m.documents / m.idsPerPage))
      throw new Error('POSTING_MANIFEST_INVALID');
    const budgets = [
      options.pageCacheBytes ?? 4 * 1048576,
      options.chunkCacheBytes ?? 4 * 1048576,
      options.idCacheBytes ?? 2 * 1048576,
    ];
    if (budgets.some((value) => !Number.isSafeInteger(value) || value < 0))
      throw new Error('POSTING_CACHE_LIMIT_INVALID');
    this.cacheLimit = budgets[0]! + budgets[1]! + budgets[2]! + lexiconLimit;
    const shared = options.pageCacheBytes === undefined &&
      options.chunkCacheBytes === undefined && options.idCacheBytes === undefined &&
      options.maxLexiconBytes === undefined
      ? new CacheBudget(lexiconLimit + budgets[1]!) : undefined;
    this.decodedCacheBudget = shared;
    this.pageCache = new ByteCache(budgets[0]!);
    this.chunkCache = new ByteCache(shared?.limit ?? budgets[1]!, shared);
    this.idCache = new ByteCache(budgets[2]!);
    this.lexiconCache = new ByteCache(shared?.limit ?? lexiconLimit, shared);
  }
  /** Counters make cold loads and repeated Base64 decoding visible in benchmarks. */
  cacheUsage(): { pages: number; chunks: number; ids: number; directory: number; lexicon: number; limit: number } {
    return {
      pages: this.pageCache.bytes,
      chunks: this.chunkCache.bytes,
      ids: this.idCache.bytes,
      directory: this.counters.directoryEstimatedBytes,
      lexicon: this.lexiconCache.bytes,
      limit: this.cacheLimit,
    };
  }
  /** Load only the sparse block directory; terms and chunk descriptors remain paged. */
  async open(): Promise<void> {
    if (!this.opened)
      this.opened = this.loadDirectory().catch((error) => {
        this.opened = undefined;
        this.directory = [];
        throw error;
      });
    await this.opened;
  }
  private async loadDirectory(): Promise<void> {
    const entries: DirectoryEntry[] = [];
    const maximum = this.options.maxLexiconBytes ?? 32 * 1048576;
    let retained = 0, decodedBytes = 0, previous = '';
    for (let start = 0; start < this.manifest.directoryPages; start += 4) {
      const numbers = Array.from({ length: Math.min(4, this.manifest.directoryPages - start) }, (_, i) => start + i);
      this.counters.storeReads++;
      const pages = await this.store.readPages(this.manifest.generation, 'directory', numbers);
      this.counters.pagesRead += pages.size;
      for (const number of numbers) {
        const payload = pages.get(number);
        if (!payload) throw new Error('POSTING_DIRECTORY_PAGE_MISSING');
        const decoded = unpackPostingPage(payload, 262144);
        this.counters.pageDecodes++;
        decodedBytes += decoded.byteLength;
        const raw: unknown = JSON.parse(new TextDecoder().decode(decoded));
        if (!Array.isArray(raw)) throw new Error('POSTING_DIRECTORY_INVALID');
        for (const entry of raw) {
          if (!isDirectoryEntry(entry) ||
              entry[0] <= previous || entry[1] !== entries.length)
            throw new Error('POSTING_DIRECTORY_INVALID');
          const value = entry;
          entries.push(value);
          previous = value[0];
          retained += 56 + 2 * value[0].length;
          if (retained > maximum || decodedBytes > maximum)
            throw new Error('POSTING_LEXICON_BUDGET_EXCEEDED');
        }
      }
    }
    if (entries.length !== this.manifest.lexiconPages)
      throw new Error('POSTING_DIRECTORY_COUNT_MISMATCH');
    this.directory = entries;
    const shared = this.decodedCacheBudget;
    if (shared)
      shared.resize(this.cacheLimit - this.pageCache.limit - this.idCache.limit - retained);
    this.lexiconCache = new ByteCache(shared?.limit ?? maximum - retained, shared);
    this.counters.directoryBytes = decodedBytes;
    this.counters.directoryEstimatedBytes = retained;
    this.counters.lexiconEstimatedBytes = retained;
  }
  private directoryLowerBound(term: string): number {
    let lo = 0, hi = this.directory.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.directory[mid]![0] < term) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  private exactPage(term: string): number | undefined {
    const entry = this.directory[this.directoryLowerBound(term)];
    return entry?.[1];
  }
  private async readLexiconPage(number: number): Promise<readonly PostingTerm[]> {
    const cached = this.lexiconCache.get(String(number));
    if (cached) return cached;
    let pending = this.pendingLexicon.get(number);
    if (!pending) {
      pending = (async () => {
        const bytes = await this.readPage('lexicon', number);
        this.counters.lexiconBytes += bytes.byteLength;
        const raw: unknown = JSON.parse(new TextDecoder().decode(bytes));
        if (!Array.isArray(raw)) throw new Error('POSTING_LEXICON_INVALID');
        const terms: PostingTerm[] = [];
        let previous = '', retained = 48;
        for (const entry of raw) {
          if (!isPostingTerm(entry) || entry[0] <= previous)
            throw new Error('POSTING_TERM_INVALID');
          if (entry.length === 2) {
            if (entry[1] >= this.manifest.documents) throw new Error('POSTING_TERM_INVALID');
          } else if (entry[1] < 2 || entry[3] < 1 || entry[5] < entry[4] ||
              entry[5] >= this.manifest.documents ||
              entry[2] + entry[3] > this.manifest.descriptorPages * this.manifest.descriptorsPerPage) {
            throw new Error('POSTING_TERM_INVALID');
          }
          const value = entry;
          terms.push(value);
          previous = value[0];
          retained += (value.length === 2 ? 64 : 96) + 2 * value[0].length;
        }
        const fence = this.directory[number];
        if (!fence || terms.at(-1)?.[0] !== fence[0] ||
            (number > 0 && terms[0]![0] <= this.directory[number - 1]![0]))
          throw new Error('POSTING_DIRECTORY_FENCE_MISMATCH');
        this.lexiconCache.put(String(number), terms, retained);
        return terms;
      })().finally(() => this.pendingLexicon.delete(number));
      this.pendingLexicon.set(number, pending);
    }
    return pending;
  }
  private readDescriptor(index: number): PostingChunk | Promise<PostingChunk> {
    const page = Math.floor(index / this.manifest.descriptorsPerPage);
    const position = index % this.manifest.descriptorsPerPage;
    const cached = this.pageCache.get('descriptors:' + page);
    if (cached) return descriptorAt(postingCachedPageBytes(cached), position);
    return this.readDescriptorPage(page, position);
  }
  private async readDescriptorPage(page: number, position: number): Promise<PostingChunk> {
    return descriptorAt(await this.readPage('descriptors', page), position);
  }
  private async readPage(kind: PostingPageKind, page: number): Promise<Uint8Array> {
    const key = kind + ':' + page;
    const hit = this.pageCache.get(key);
    if (hit) return postingCachedPageBytes(hit);
    const pending = this.pendingPages.get(key);
    if (pending) return pending;
    this.startPageReads(kind, [page]);
    return this.pendingPages.get(key)!;
  }
  private startPageReads(kind: PostingPageKind, numbers: readonly number[]): void {
    const read = (async () => {
      this.counters.storeReads++;
      const pages = await this.store.readPages(this.manifest.generation, kind, numbers);
      this.counters.pagesRead += pages.size;
      return pages;
    })();
    // Each printable ASCII ID has one length byte and at most 128 payload bytes.
    const maxBytes = kind === 'ids' ? this.manifest.idsPerPage * 129
      : kind === 'lexicon' || kind === 'directory' ? 262144 : 131072;
    for (const page of numbers) {
      const key = kind + ':' + page;
      const pending = read.then((pages) => {
        const value = pages.get(page);
        if (!value) throw new Error('POSTING_PAGE_MISSING:' + kind + ':' + page);
        const decoded = unpackPostingPage(value, maxBytes);
        this.counters.pageDecodes++;
        this.pageCache.put(key, decoded, decoded.byteLength);
        return decoded;
      }).finally(() => this.pendingPages.delete(key));
      this.pendingPages.set(key, pending);
    }
  }
  private readChunk(chunk: PostingChunk): PostingChunkValues | Promise<PostingChunkValues> {
    // Native bounds: <1M pages, <128 KiB offset and at most 4096 five-byte IDs.
    // The complete page/offset/length identity fits exactly below 2^52.
    const key = (chunk[0] * 131072 + chunk[1]) * 32768 + chunk[2];
    const hit = this.chunkCache.get(key);
    if (hit) return hit;
    let pending = this.pendingChunks.get(key);
    if (!pending) {
      pending = this.loadChunk(chunk, key);
      this.pendingChunks.set(key, pending);
    }
    return pending;
  }
  private async loadChunk(chunk: PostingChunk, key: number): Promise<PostingChunkValues> {
    try {
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
      const values = compactPostingChunk(decoded, chunk);
      this.chunkCache.put(key, values, values.byteLength);
      return values;
    } finally {
      this.pendingChunks.delete(key);
    }
  }
  private termLowerBound(entries: readonly PostingTerm[], term: string): number {
    let lo = 0, hi = entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (entries[mid]![0] < term) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  /** Coalesce a multi-gram lookup into bounded reads of distinct lexicon blocks. */
  private async exactMany(terms: readonly string[], includeCaseSensitiveKeys = false): Promise<readonly PostingTerm[][]> {
    const keys = terms.flatMap((term) => includeCaseSensitiveKeys ? [term, caseSensitivePostingPrefix + term] : [term]);
    const pages = [...new Set(keys.map((key) => this.exactPage(key)).filter((number): number is number => number !== undefined))];
    for (let offset = 0; offset < pages.length; offset += 4) {
      const batch = pages.slice(offset, offset + 4);
      const missing = batch.filter((number) => !this.lexiconCache.has(String(number)) &&
        !this.pageCache.has('lexicon:' + number) && !this.pendingPages.has('lexicon:' + number));
      if (missing.length) this.startPageReads('lexicon', missing);
      await completeReads(batch.map((number) => this.readLexiconPage(number)));
    }
    return completeReads(terms.map((term) => this.exact(term, includeCaseSensitiveKeys)));
  }
  private async exact(term: string, includeCaseSensitiveKeys = false): Promise<PostingTerm[]> {
    const entries: PostingTerm[] = [];
    for (const key of includeCaseSensitiveKeys ? [term, caseSensitivePostingPrefix + term] : [term]) {
      const number = this.exactPage(key);
      if (number === undefined) continue;
      const page = await this.readLexiconPage(number);
      const found = page[this.termLowerBound(page, key)];
      if (found?.[0] === key) entries.push(found);
    }
    return entries;
  }
  private async prefixMany(words: readonly string[], includeCaseSensitiveKeys: boolean): Promise<PostingTerm[][]> {
    const reads = words.map((word) => this.prefix('w|' + word, includeCaseSensitiveKeys));
    return Promise.all(reads).catch(async (error: unknown) => {
      const settled = await Promise.allSettled(reads);
      const complete: PostingTerm[][] = [];
      for (const result of settled) {
        if (result.status === 'fulfilled') complete.push(result.value);
        else if (!this.matchedTermLimitError || result.reason !== this.matchedTermLimitError)
          throw result.reason;
      }
      // Every true match belongs to each complete group. Discard an overflowing
      // group entirely; the current-source ranker still verifies every word.
      // A complete empty group proves this tier empty and must be retained.
      if (complete.length) return complete;
      throw error;
    });
  }
  private async prefix(term: string, includeCaseSensitiveKeys = false): Promise<PostingTerm[]> {
    const limit = this.options.maxMatchedTerms ?? 20000;
    const entries: PostingTerm[] = [];
    await this.appendMatchingTerms(entries, term, limit);
    if (includeCaseSensitiveKeys)
      await this.appendMatchingTerms(entries, caseSensitivePostingPrefix + term, limit);
    return entries;
  }
  private async appendMatchingTerms(entries: PostingTerm[], term: string, limit: number): Promise<void> {
    for (let index = this.directoryLowerBound(term); index < this.directory.length; index++) {
      const fence = this.directory[index]!;
      const page = await this.readLexiconPage(fence[1]);
      for (let at = this.termLowerBound(page, term); at < page.length; at++) {
        const entry = page[at]!;
        if (!entry[0].startsWith(term)) return;
        if (entries.length >= limit)
          throw (this.matchedTermLimitError ??= new Error('POSTING_MATCHED_TERM_LIMIT'));
        entries.push(entry);
      }
    }
  }
  private listCursor(entry: PostingTerm, tick: () => void): ListCursor {
    const firstDescriptor = entry.length === 2 ? 0 : entry[2];
    return new ListCursor(entry, (index) => this.readDescriptor(firstDescriptor + index), (chunk) => this.readChunk(chunk), tick);
  }
  private cursor(entries: readonly PostingTerm[], tick: () => void): Cursor {
    if (!entries.length) return emptyCursor();
    const lists = entries.map((entry) => this.listCursor(entry, tick));
    return lists.length === 1 ? lists[0]! : new UnionCursor(lists, tick);
  }
  private intersection(
    groups: readonly (readonly PostingTerm[])[],
    tick: () => void
  ): Cursor {
    // Sort by the posting lengths once so the smallest group drives the intersection.
    const groupsBySize: { entries: readonly PostingTerm[]; size: number }[] = [];
    for (const entries of groups) {
      if (!entries.length) return emptyCursor();
      let size = 0;
      for (const entry of entries) size += entry.length === 2 ? 1 : entry[1];
      groupsBySize.push({ entries, size });
    }
    groupsBySize.sort((a, b) => a.size - b.size);
    if (groupsBySize.length > 1 && groupsBySize.every(({ entries }) => entries.length === 1)) {
      const cursors = groupsBySize.map(({ entries }) => this.listCursor(entries[0]!, tick));
      return new LocalMembershipIntersectionCursor(cursors, tick);
    }
    return new IntersectionCursor(
      groupsBySize.map(({ entries }) => this.cursor(entries, tick)),
      tick
    );
  }
  private cachedObjectId(ordinal: number): string | undefined {
    const block = this.idCache.get(Math.floor(ordinal / postingObjectIdBlockSize));
    return block && cachedPostingObjectId(block, ordinal % postingObjectIdBlockSize);
  }

  private rememberObjectId(ordinal: number, id: string): void {
    const key = Math.floor(ordinal / postingObjectIdBlockSize);
    const previous = this.idCache.get(key);
    const block = cachePostingObjectId(previous, ordinal % postingObjectIdBlockSize, id, this.idCache.limit);
    if (block && block !== previous) this.idCache.put(key, block, postingObjectIdBlockBytes(block));
  }

  private async objectIds(ordinals: readonly number[]): Promise<string[]> {
    const result = new Array<string>(ordinals.length);
    let pages: Map<number, PostingObjectIdPage | undefined> | undefined;
    let blockNumber = -1;
    let block: PostingObjectIdBlock | undefined;
    for (let index = 0; index < ordinals.length; index++) {
      const ordinal = ordinals[index]!;
      const number = Math.floor(ordinal / postingObjectIdBlockSize);
      if (number !== blockNumber) {
        blockNumber = number;
        block = this.idCache.get(number);
      }
      const id = block && cachedPostingObjectId(block, ordinal % postingObjectIdBlockSize);
      if (id !== undefined) {
        result[index] = id;
        continue;
      }
      const pageNumber = Math.floor(ordinal / this.manifest.idsPerPage);
      pages ??= new Map();
      pages.set(pageNumber, undefined);
    }
    if (!pages) return result;
    const missing = [...pages.keys()];
    if (missing.length === 1) {
      const number = missing[0]!;
      pages.set(number, await this.readIdPage(number));
    } else {
      // Keep the existing four-page cold-response bound and only call-local decoded pages.
      for (let start = 0; start < missing.length; start += 4) {
        const batch = missing.slice(start, start + 4);
        this.prefetchIdPages(batch);
        await completeReads(batch.map(async (number) => {
          pages!.set(number, await this.readIdPage(number));
        }));
      }
    }
    for (let index = 0; index < ordinals.length; index++) {
      if (result[index] !== undefined) continue;
      const ordinal = ordinals[index]!;
      const id = postingObjectIdAt(
        pages.get(Math.floor(ordinal / this.manifest.idsPerPage))!,
        ordinal % this.manifest.idsPerPage
      );
      result[index] = id;
      this.rememberObjectId(ordinal, id);
    }
    return result;
  }

  private prefetchIdPages(numbers: readonly number[]): void {
    const unread: number[] = [];
    for (const number of numbers) {
      const key = 'ids:' + number;
      if (!this.pageCache.has(key) && !this.pendingPages.has(key))
        unread.push(number);
    }
    if (unread.length > 1) this.startPageReads('ids', unread);
  }

  private async readIdPage(number: number): Promise<PostingObjectIdPage> {
    const key = 'ids:' + number;
    const cached = this.pageCache.get(key);
    if (cached && !(cached instanceof Uint8Array)) return cached;
    let bytes = cached;
    if (!bytes) {
      bytes = await this.readPage('ids', number);
      // A concurrent consumer may already have parsed the shared raw response.
      const shared = this.pageCache.get(key);
      if (shared && !(shared instanceof Uint8Array)) return shared;
    }
    const expected = Math.min(
      this.manifest.idsPerPage,
      this.manifest.documents - number * this.manifest.idsPerPage
    );
    const page = decodePostingObjectIds(bytes, expected);
    // The Buffer shares raw storage. Calibrated metadata includes views, objects and cache entry.
    this.pageCache.put(key, page, bytes.byteLength + page.offsets.byteLength + 704);
    return page;
  }
  /** Enumerate immutable, ascending IDs in batches using only ID pages. */
  async *idBatches(): AsyncGenerator<readonly string[]> {
    const readSize = 8;
    let previous = '';
    for (let start = 0; start < this.manifest.idPages; start += readSize) {
      const numbers: number[] = [];
      const end = Math.min(start + readSize, this.manifest.idPages);
      for (let page = start; page < end; page++) numbers.push(page);
      this.prefetchIdPages(numbers);
      const batches = await completeReads(numbers.map((number) => this.readIdPage(number)));
      for (const page of batches) {
        const ids: string[] = [];
        for (let index = 0; index + 1 < page.offsets.length; index++)
          ids.push(postingObjectIdAt(page, index));
        if (ids[0]! <= previous) throw new Error('POSTING_OBJECT_IDS_INVALID');
        previous = ids[ids.length - 1]!;
        yield ids;
      }
    }
  }

  /**
   * Return successive pages in tier/objectId order. A token is scoped to this immutable
   * generation, search text and caller's source query; it cannot be edited to skip rows.
   * Each request rechecks current rows. Live rank changes can move rows across the
   * cursor. Include a source revision in scopeKey to restart traversal when ranks
   * change. An index generation change also invalidates the token.
   */
  async searchPage<T>(options: PostingPageOptions<T>): Promise<PostingPageResult<T>> {
    checkPostingQueryLength(options.text);
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
    const digest = postingCursorDigest([
      this.manifest.generation, this.manifest.kinds, request.text.normalize('NFC'),
      Boolean(request.caseSensitive), scopeKey,
    ]);
    let after: { tier: number; ordinal: number } | undefined;
    if (cursor) {
      const [tier, ordinal] = readPostingCursor(cursor, signingKey, digest, this.manifest.kinds.length * 2 + 2);
      if (
        typeof ordinal !== 'number' || !Number.isSafeInteger(ordinal) ||
        ordinal < 0 || ordinal >= this.manifest.documents
      )
        throw new Error('POSTING_CURSOR_INVALID');
      after = { tier, ordinal };
    }
    // One extra accepted row proves there really is another page. Never count a
    // denied row or a stale-name false positive as proof that more results exist.
    const { result, positions } = await this.searchRun(request, after, true);
    if (result.results.length <= limit) return result;
    const last = positions[limit - 1]!;
    const nextCursor = writePostingCursor(signingKey, digest, last.tier, last.ordinal);
    return { ...result, results: result.results.slice(0, limit), nextCursor };
  }

  /** Return a signed page across readers with the same ordered name kinds. */
  static async searchCompositePage<T>(
    readers: readonly [PostingReader, ...PostingReader[]],
    options: PostingCompositePageOptions<T>
  ): Promise<PostingCompositePageResult<T>> {
    checkPostingQueryLength(options.text);
    const { signingKey, scopeKey, cursor, limit = 10, readLive } = options;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !scopeKey || signingKey.length < 16)
      throw new Error('POSTING_PAGE_OPTIONS_INVALID');
    const limits = postingQueryLimits(options);
    const { kinds } = readers[0].manifest;
    const generations: string[] = [];
    for (const { manifest } of readers) {
      if (manifest.kinds.length !== kinds.length || manifest.kinds.some((kind, index) => kind !== kinds[index]))
        throw new Error('POSTING_COMPOSITE_KINDS_MISMATCH');
      generations.push(manifest.generation);
    }
    const digest = postingCursorDigest([
      generations, kinds, options.text.normalize('NFC'), Boolean(options.caseSensitive), scopeKey, Boolean(readLive),
    ]);
    const kindRanks = createPostingKindRanks(kinds);
    let after: PostingRankBoundary | undefined;
    let afterTier = 0;
    if (cursor) {
      const [tier, id] = readPostingCursor(cursor, signingKey, digest, kinds.length * 2 + 2);
      if (typeof id !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(id))
        throw new Error('POSTING_CURSOR_INVALID');
      const { stage, kind } = createPostingTiers(kinds)[tier]!;
      after = { stage, kind, id };
      afterTier = tier;
    }
    const nonblank = Boolean(options.text.trim());
    const snapshotReads = readers.map(async (reader) => {
      const position = after && nonblank ? await reader.rankPosition(afterTier, after.id) : undefined;
      return reader.searchRun(options, position, true, limits);
    });
    const liveRead = nonblank && readLive ? Promise.resolve().then(() => readLive(after, limit + 1)) : [];
    const [snapshots, live] = await Promise.all([Promise.all(snapshotReads), liveRead]).catch(async (error: unknown) => {
      // The request owns its callbacks until settlement, including when a stream fails.
      await Promise.allSettled([...snapshotReads, liveRead]);
      throw error;
    });
    const page: PostingCompositePageResult<T> = {
      results: [],
      coverage: snapshots[0]!.result.coverage,
      sourceReads: 0,
      sourceCandidates: 0,
      sourceRows: 0,
      cursorSteps: 0,
      liveRows: live.length,
    };
    const streams: PostingRankedPrefix<T>[] = [];
    for (const { result, positions } of snapshots) {
      page.sourceReads += result.sourceReads;
      page.sourceCandidates += result.sourceCandidates;
      page.sourceRows += result.sourceRows;
      page.cursorSteps += result.cursorSteps;
      streams.push({ results: result.results, rankAt: (index) => positions[index]!.tier });
    }
    if (live.length)
      streams.push({ results: live, rankAt: (index) => postingTierRank(live[index]!, kindRanks)! });
    // A full stream prefix alone contains limit+1 distinct IDs. No omitted row
    // can precede the merged lookahead, even when every stream overlaps.
    page.results = mergePostingPrefixes(streams, options.getId, limit + 1);
    if (page.results.length > limit) {
      page.results.pop();
      const last = page.results[limit - 1]!;
      page.nextCursor = writePostingCursor(
        signingKey, digest, postingTierRank(last, kindRanks)!, options.getId(last.object)
      );
    }
    return page;
  }

  /** Search starts at the beginning when no paging cursor was provided. */
  async search<T>(options: PostingSearchOptions<T>): Promise<PostingSearchResult<T>> {
    checkPostingQueryLength(options.text);
    return (await this.searchRun(options)).result;
  }
  /**
   * Continue from a global rank/ID pair. The ID may belong to a newer live
   * overlay and therefore not exist in this snapshot.
   * Use searchCompositePage to sign and merge pages from several streams.
   */
  async searchAfterRank<T>(
    options: PostingSearchOptions<T>,
    last?: PostingRankBoundary
  ): Promise<PostingSearchResult<T>> {
    if (!last) return this.search(options);
    checkPostingQueryLength(options.text);
    const tier = postingTierRank(last, createPostingKindRanks(this.manifest.kinds));
    if (tier === undefined || !/^[\x21-\x7e]{1,128}$/.test(last.id))
      throw new Error('POSTING_RANK_CURSOR_INVALID');
    if (!options.text.trim()) return (await this.searchRun(options)).result;
    return (await this.searchRun(options, await this.rankPosition(tier, last.id))).result;
  }
  private async rankPosition(tier: number, lastId: string): Promise<{ tier: number; ordinal: number }> {
    await this.open();
    // The boundary may not exist in this generation. Cache only examined midpoint IDs.
    const { idsPerPage } = this.manifest;
    let loadedPage = -1;
    let ids: PostingObjectIdPage | undefined;
    let low = 0,
      high = this.manifest.documents;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      const key = mid;
      let id = this.cachedObjectId(key);
      if (id === undefined) {
        const page = Math.floor(mid / idsPerPage);
        if (page !== loadedPage) {
          ids = await this.readIdPage(page);
          loadedPage = page;
        }
        id = postingObjectIdAt(ids!, mid % idsPerPage);
        this.rememberObjectId(key, id);
      }
      if (id <= lastId) low = mid + 1;
      else high = mid;
    }
    return { tier, ordinal: low - 1 };
  }
  /** Find the ranked prefix of authorized matches, without fetching/sorting the entire candidate set. */
  private async searchRun<T>(
    options: PostingSearchOptions<T>,
    after?: { tier: number; ordinal: number },
    includeLookahead = false,
    limits = postingQueryLimits(options)
  ): Promise<{
    result: PostingSearchResult<T>;
    positions: Array<{ tier: number; ordinal: number }>;
  }> {
    const [limit, batchSize, maxSourceCandidates, maxCursorSteps] = limits;
    const resultLimit = includeLookahead ? limit + 1 : limit;
    const matchingPhrase = options.caseSensitive
      ? options.text.normalize('NFC').trim()
      : foldPostingText(options.text);
    const lookupPhrase = options.caseSensitive ? lowercasePostingText(matchingPhrase) : matchingPhrase;
    const words = lookupPhrase.split(/\s+/u).filter(Boolean);
    const ordinarySingleCharacter = ordinaryPostingCharacter.test(matchingPhrase);
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
    if (words.length > 32) throw new Error('POSTING_QUERY_TOO_LONG');
    await this.open();
    const includeCaseSensitiveKeys =
      options.caseSensitive && this.directory.at(-1)?.[0].startsWith(caseSensitivePostingPrefix);
    const matchingWords = options.caseSensitive ? matchingPhrase.split(/\s+/u) : words;
    let cursorLimitError: Error | undefined;
    const tick = () => {
      if (result.cursorSteps >= maxCursorSteps)
        throw (cursorLimitError ??= new Error('POSTING_CURSOR_LIMIT'));
      result.cursorSteps++;
    };
    // Retain source snapshots only for this search; rank each row when consumed.
    const sourceRows = new Map<number, { object: T; rank?: number } | null>();
    const accepted = new Set<number>();
    const gramTerms = new Set<string>();
    let shortInMatchingMode = Boolean(options.caseSensitive && words.length > 1);
    for (let index = 0; index < words.length; index++) {
      const word = words[index]!;
      if (shortInMatchingMode && !ordinaryPostingCharacter.test(matchingWords[index]!))
        shortInMatchingMode = false;
      const count = Array.from(word).length;
      if (count >= 2) {
        for (const gram of postingGrams(word, Math.min(3, count))) gramTerms.add(gram);
      } else if (/^\p{S}$/u.test(word)) gramTerms.add('g1|' + word);
    }
    if (words.length > 1 && (!gramTerms.size || shortInMatchingMode))
      throw new Error('POSTING_QUERY_TOO_SHORT');
    const tiers = createPostingTiers(this.manifest.kinds, ordinarySingleCharacter);
    const rankQuery: PostingRankQuery = {
      phrase: matchingPhrase,
      words: matchingWords,
      caseSensitive: options.caseSensitive,
      prefixOnly: ordinarySingleCharacter,
      kindRanks: createPostingKindRanks(this.manifest.kinds),
    };
    let wordGroups: PostingTerm[][] | undefined;
    for (const [tierNumber, tier] of tiers.entries()) {
      if (result.results.length >= resultLimit) break;
      if (after && tierNumber < after.tier) continue;
      let cursor: Cursor;
      if (tier.stage === 'exact') {
        const key = postingNameKey(tier.kind, lookupPhrase);
        cursor = this.cursor(await this.exact(key, includeCaseSensitiveKeys), tick);
      } else if (tier.stage === 'prefix') {
        const key = postingNameKey(tier.kind, lookupPhrase);
        try {
          cursor = this.cursor(await this.prefix(key, includeCaseSensitiveKeys), tick);
        } catch (error) {
          if (!this.matchedTermLimitError || error !== this.matchedTermLimitError) throw error;
          // Name-prefix matches also satisfy the query's word prefixes. Keep
          // the original kind/tier check when this complete superset nominates.
          wordGroups ??= await this.prefixMany([...new Set(words)], Boolean(includeCaseSensitiveKeys));
          cursor = this.intersection(wordGroups, tick);
        }
      } else if (tier.stage === 'word-prefix') {
        wordGroups ??= await this.prefixMany([...new Set(words)], Boolean(includeCaseSensitiveKeys));
        cursor = this.intersection(wordGroups, tick);
      } else {
        cursor = this.intersection(
          await this.exactMany(Array.from(gramTerms), includeCaseSensitiveKeys), tick
        );
      }
      let nextOrdinal = after && tierNumber === after.tier ? after.ordinal + 1 : 0;
      let examinedInTier = 0, acceptedInTier = 0;
      // A monotone cursor cannot revisit a denied ordinal in the final tier.
      const retainRejected = tierNumber + 1 < tiers.length;
      while (result.results.length < resultLimit && cursor.peek() !== Infinity) {
        const candidates: number[] = [];
        const missing: number[] = [];
        const remainingResults = resultLimit - result.results.length;
        const expectedCandidates = acceptedInTier
          ? Math.ceil(remainingResults * examinedInTier / acceptedInTier)
          : examinedInTier ? batchSize : remainingResults;
        const size = Math.min(
          batchSize, expectedCandidates,
          Math.max(1, maxSourceCandidates - result.sourceCandidates)
        );
        let deferredCursorLimit: Error | undefined;
        try {
          while (candidates.length < size) {
            let ordinal = cursor.peek();
            if (ordinal < nextOrdinal) {
              const located = cursor.seek(nextOrdinal);
              ordinal = located instanceof Promise ? await located : located;
            }
            if (ordinal === Infinity) break;
            tick();
            nextOrdinal = ordinal + 1;
            const source = sourceRows.get(ordinal);
            if (source === null || (source !== undefined && accepted.has(ordinal))) continue;
            candidates.push(ordinal);
            if (source === undefined) missing.push(ordinal);
          }
        } catch (error) {
          if (!cursorLimitError || error !== cursorLimitError || !candidates.length) throw error;
          // A buffered prefix can satisfy demand without the speculative tail.
          deferredCursorLimit = cursorLimitError;
        }
        if (!candidates.length) break;
        if (missing.length) {
          result.sourceCandidates += missing.length;
          if (result.sourceCandidates > maxSourceCandidates)
            throw new Error('POSTING_SOURCE_CANDIDATE_LIMIT');
          const ids = await this.objectIds(missing);
          result.sourceReads++;
          const fetched = await options.fetchSources(ids);
          result.sourceRows += fetched.length;
          if (!fetched.length) {
            // Sparse eligibility often rejects a whole batch. Preserve the filter
            // callback while avoiding maps and sets for rows that do not exist.
            if (options.filterCandidates) await options.filterCandidates(fetched);
            if (retainRejected) for (const ordinal of missing) sourceRows.set(ordinal, null);
            if (missing.length === candidates.length) {
              examinedInTier += candidates.length;
              if (deferredCursorLimit) throw deferredCursorLimit;
              continue;
            }
          } else {
            const allowedIds = new Set(ids);
            // Check requested IDs before calling the caller's extra eligibility filter.
            const fetchedById = new Map<string, T>();
            for (const object of fetched) {
              const id = options.getId(object);
              if (!allowedIds.has(id)) throw new Error('POSTING_SOURCE_OUTSIDE_REQUEST');
              fetchedById.set(id, object);
            }
            const allowed = options.filterCandidates
              ? new Set((await options.filterCandidates(fetched)).map((object) => options.getId(object)))
              : allowedIds;
            for (let index = 0; index < missing.length; index++) {
              const id = ids[index]!, ordinal = missing[index]!;
              const object = fetchedById.get(id);
              if ((object !== undefined || fetchedById.has(id)) && allowed.has(id)) {
                sourceRows.set(ordinal, { object: object as T });
              } else if (retainRejected) {
                sourceRows.set(ordinal, null);
              }
            }
          }
        }
        for (const ordinal of candidates) {
          examinedInTier++;
          const source = sourceRows.get(ordinal);
          if (!source) continue;
          if (source.rank === undefined)
            source.rank = findBestPostingRank(options.getNames(source.object), rankQuery);
          if (source.rank !== tierNumber) continue;
          acceptedInTier++;
          accepted.add(ordinal);
          result.results.push({ object: source.object, stage: tier.stage, kind: tier.kind });
          positions.push({ tier: tierNumber, ordinal });
          if (result.results.length >= resultLimit) break;
        }
        if (deferredCursorLimit && result.results.length < resultLimit) throw deferredCursorLimit;
      }
    }
    return { result, positions };
  }
}
