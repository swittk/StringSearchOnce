/** Immutable generation IDs requested within one ordinal range. */
export type PostingObjectIdBlock = {
  ordinals: Uint16Array;
  starts: Uint32Array;
  bytes: Buffer;
  count: number;
  used: number;
};

export const postingObjectIdBlockSize = 16384;
const blockMetadataBytes = 1024;

export function postingObjectIdBlockBytes(block: PostingObjectIdBlock): number {
  return blockMetadataBytes + block.ordinals.byteLength + block.starts.byteLength + block.bytes.byteLength;
}

function lowerBound(block: PostingObjectIdBlock, ordinal: number): number {
  if (!block.count || ordinal > block.ordinals[block.count - 1]!) return block.count;
  let lo = 0, hi = block.count;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (block.ordinals[mid]! < ordinal) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function cachedPostingObjectId(block: PostingObjectIdBlock, ordinal: number): string | undefined {
  const at = lowerBound(block, ordinal);
  if (at === block.count || block.ordinals[at] !== ordinal) return;
  const start = block.starts[at]!;
  return block.bytes.toString('latin1', start + 1, start + 1 + block.bytes[start]!);
}

export function cachePostingObjectId(
  previous: PostingObjectIdBlock | undefined,
  ordinal: number,
  id: string,
  limit: number
): PostingObjectIdBlock | undefined {
  const at = previous ? lowerBound(previous, ordinal) : 0;
  if (previous && at < previous.count && previous.ordinals[at] === ordinal) return previous;
  const count = previous?.count ?? 0, used = previous?.used ?? 0;
  let entries = previous?.ordinals.length ?? 4;
  if (entries === count) entries *= 2;
  let bytes = previous?.bytes.byteLength ?? 64;
  while (bytes < used + 1 + id.length) bytes *= 2;
  const charge = blockMetadataBytes + entries * 6 + bytes;
  if (charge > limit) return previous;

  let block = previous;
  if (!block || entries !== block.ordinals.length || bytes !== block.bytes.byteLength) {
    block = {
      ordinals: new Uint16Array(entries), starts: new Uint32Array(entries),
      bytes: Buffer.allocUnsafeSlow(bytes), count, used,
    };
    if (previous) {
      block.ordinals.set(previous.ordinals.subarray(0, count));
      block.starts.set(previous.starts.subarray(0, count));
      block.bytes.set(previous.bytes.subarray(0, used));
    }
  }
  if (at < count) {
    block.ordinals.copyWithin(at + 1, at, count);
    block.starts.copyWithin(at + 1, at, count);
  }
  block.ordinals[at] = ordinal;
  block.starts[at] = used;
  block.bytes[used] = id.length;
  block.bytes.write(id, used + 1, id.length, 'latin1');
  block.count = count + 1;
  block.used = used + 1 + id.length;
  return block;
}
