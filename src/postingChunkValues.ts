import type { PostingChunk } from './postingFormat';

/**
 * Cache a chunk in its smallest native representation. Uint16 values are offsets
 * from the descriptor's first ordinal. A Uint32 buffer shorter than the descriptor's
 * count is a bitmap over that same ordinal span; other Uint32 buffers hold ordinals.
 * The descriptor already supplies the count and first ordinal, so cached values need
 * no separate object or metadata allocation.
 */
export type PostingChunkValues = Uint16Array | Uint32Array;

export function compactPostingChunk(ids: Uint32Array, chunk: PostingChunk): PostingChunkValues {
  const first = chunk[4], span = chunk[5] - first;
  const short = span <= 0xffff;
  const words = Math.floor(span / 32) + 1;
  if (words * 4 < ids.length * (short ? 2 : 4)) {
    const bits = new Uint32Array(words);
    for (const id of ids) {
      const offset = id - first, word = offset >>> 5;
      bits[word] = bits[word]! | (1 << (offset & 31));
    }
    return bits;
  }
  if (short) {
    const offsets = new Uint16Array(ids.length);
    for (let index = 0; index < ids.length; index++) offsets[index] = ids[index]! - first;
    return offsets;
  }
  return ids;
}

/** Return a monotone element index, or a bit offset for a bitmap. */
export function seekPostingChunk(
  values: PostingChunkValues, chunk: PostingChunk, target: number, from: number
): number {
  if (values.length < chunk[3]) {
    const offset = Math.max(0, target - chunk[4]);
    let word = Math.floor(offset / 32);
    let bits = values[word]! & (0xffffffff << (offset & 31));
    while (!bits && ++word < values.length) bits = values[word]!;
    return bits ? word * 32 + 31 - Math.clz32(bits & -bits) : Infinity;
  }
  const relative = values instanceof Uint16Array ? target - chunk[4] : target;
  let left = from, right = values.length;
  if (values[left]! >= relative) return left;
  left++;
  while (left < right) {
    const mid = (left + right) >>> 1;
    if (values[mid]! < relative) left = mid + 1;
    else right = mid;
  }
  return left;
}

export function postingChunkOrdinal(values: PostingChunkValues, chunk: PostingChunk, index: number): number {
  if (values.length < chunk[3]) return chunk[4] + index;
  const value = values[index];
  return value === undefined ? Infinity : values instanceof Uint16Array ? chunk[4] + value : value;
}

function lowerBound(values: PostingChunkValues, target: number): number {
  let lo = 0, hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Count a bounded ordinal range without expanding a compact chunk. */
export function countPostingChunkRange(
  values: PostingChunkValues, chunk: PostingChunk, lower: number, upper: number,
  stopAt = Infinity
): number {
  const first = chunk[4], last = chunk[5];
  if (lower > last || upper < first) return 0;
  if (values.length === chunk[3]) {
    const base = values instanceof Uint16Array ? first : 0;
    const from = lower <= first ? 0 : lowerBound(values, lower - base);
    const to = upper >= last ? values.length : lowerBound(values, upper + 1 - base);
    return to - from;
  }
  const start = Math.max(0, lower - first), end = Math.min(last - first, upper - first);
  const startWord = Math.floor(start / 32), endWord = Math.floor(end / 32);
  let count = 0;
  for (let word = startWord; word <= endWord; word++) {
    let bits = values[word]!;
    if (word === startWord) bits &= 0xffffffff << (start & 31);
    if (word === endWord) bits &= 0xffffffff >>> (31 - (end & 31));
    bits -= (bits >>> 1) & 0x55555555;
    bits = (bits & 0x33333333) + ((bits >>> 2) & 0x33333333);
    count += Math.imul((bits + (bits >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
    if (count >= stopAt) break;
  }
  return count;
}

/** Copy an admitted range directly into the existing candidate buffer. */
export function copyPostingChunkRange(
  values: PostingChunkValues, chunk: PostingChunk, lower: number, upper: number,
  destination: Uint32Array, at: number
): void {
  const first = chunk[4], last = chunk[5];
  if (lower > last || upper < first) return;
  if (values.length === chunk[3]) {
    const base = values instanceof Uint16Array ? first : 0;
    const from = lower <= first ? 0 : lowerBound(values, lower - base);
    const to = upper >= last ? values.length : lowerBound(values, upper + 1 - base);
    for (let index = from; index < to; index++) destination[at++] = base + values[index]!;
    return;
  }
  const start = Math.max(0, lower - first), end = Math.min(last - first, upper - first);
  const startWord = Math.floor(start / 32), endWord = Math.floor(end / 32);
  for (let word = startWord; word <= endWord; word++) {
    let bits = values[word]!;
    if (word === startWord) bits &= 0xffffffff << (start & 31);
    if (word === endWord) bits &= 0xffffffff >>> (31 - (end & 31));
    while (bits) {
      const low = bits & -bits;
      destination[at++] = first + word * 32 + 31 - Math.clz32(low);
      bits ^= low;
    }
  }
}

/** Materialize just the candidate suffix, with no intermediate expanded chunk. */
export function postingChunkOrdinals(
  values: PostingChunkValues, chunk: PostingChunk, lower = chunk[4]
): Uint32Array {
  if (values instanceof Uint32Array && values.length === chunk[3])
    return values.slice(lower <= chunk[4] ? 0 : lowerBound(values, lower));
  const ids = new Uint32Array(countPostingChunkRange(values, chunk, lower, chunk[5]));
  copyPostingChunkRange(values, chunk, lower, chunk[5], ids, 0);
  return ids;
}
