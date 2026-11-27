import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { lowercasePostingText } from './postingText';

/**
 * Compatibility of stored posting pages and their persisted text/key semantics.
 * Change only when existing indexes need rebuilding, independently of package
 * releases and signed-cursor versions.
 */
export const POSTING_INDEX_COMPATIBILITY_VERSION = 1;

/** One selected source name. The index does not inspect arbitrary object fields. */
export type PostingName = { kind: string; text: string };
/** A source row supplied to the offline generation builder. */
export type PostingDocument = { id: string; names: readonly PostingName[] };
/** [page number, byte offset, byte length, ID count, first ordinal, last ordinal]. */
export type PostingChunk = readonly [number, number, number, number, number, number];
/** A singleton needs only its term and ordinal; larger lists use paged descriptors. */
export type PostingTerm = readonly [term: string, ordinal: number] | readonly [
  term: string, count: number, firstDescriptor: number, descriptorCount: number,
  firstOrdinal: number, lastOrdinal: number,
];
/** Inclusive upper term fence for a bounded lexicon page, in UTF-16 comparison order. */
export type PostingDirectoryEntry = readonly [lastTerm: string, lexiconPage: number];
/** Six unsigned 32-bit fields per chunk location, encoded in little-endian order. */
export const POSTING_DESCRIPTOR_BYTES = 6 * Uint32Array.BYTES_PER_ELEMENT;
/** A reader always binds to one immutable generation; it never mixes two builds. */
export type PostingManifest = {
  format: typeof POSTING_INDEX_COMPATIBILITY_VERSION;
  generation: string;
  documents: number;
  terms: number;
  kinds: readonly string[];
  directoryPages: number;
  lexiconPages: number;
  descriptorPages: number;
  postingPages: number;
  idPages: number;
  idsPerPage: number;
  descriptorsPerPage: number;
};
/** A compressed page is binary; the storage adapter owns any transport encoding. */
export type PostingBytes = Uint8Array;
export type PostingPageKind = 'directory' | 'lexicon' | 'descriptors' | 'postings' | 'ids';
/** Fetch only explicitly named pages from one private, immutable generation. */
export interface PostingPageStore {
  readPages(
    generation: string,
    kind: PostingPageKind,
    pages: readonly number[]
  ): Promise<ReadonlyMap<number, PostingBytes>>;
}
/** Persist one encoded page into an unpublished generation owned by the caller. */
export interface PostingPageSink {
  writePage(generation: string, kind: PostingPageKind, page: number, bytes: PostingBytes): Promise<void>;
}
/** Everything produced by a build, before publication. No source rows are stored here. */
export type BuiltPostingGeneration = {
  manifest: PostingManifest;
  pages: ReadonlyMap<PostingPageKind, readonly PostingBytes[]>;
};

/** Lowercase NFC text, normalize final sigma, and retain accents and combining marks. */
export function foldPostingText(text: string): string {
  return lowercasePostingText(text.normalize('NFC')).normalize('NFC').trim();
}
/** Bytewise ASCII object-ID order; never use language collation for posting ordinals. */
export function comparePostingIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
/** Escape a kind through JSON so arbitrary registered field priorities cannot collide. */
export function postingNameKey(kind: string, text: string): string {
  return 'n' + JSON.stringify(kind) + '|' + text;
}
/** Build all overlapping code-point grams, preserving surrogate pairs and combining marks. */
export function postingGrams(text: string, width: number): string[] {
  const chars = Array.from(text),
    values = new Set<string>();
  for (let i = 0; i + width <= chars.length; i++)
    values.add('g' + width + '|' + chars.slice(i, i + width).join(''));
  return [...values];
}
/** Encode a strictly increasing list as unsigned delta-varints. */
export function encodePostingIds(ids: readonly number[]): Uint8Array {
  const bytes: number[] = [];
  let previous = 0;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]!;
    if (!Number.isSafeInteger(id) || id < 0 || id > 0xffffffff || (i > 0 && id <= previous))
      throw new Error('POSTING_IDS_NOT_ORDERED');
    let delta = id - previous;
    while (delta >= 128) {
      bytes.push((delta & 127) | 128);
      delta = Math.floor(delta / 128);
    }
    bytes.push(delta);
    previous = id;
  }
  return Uint8Array.from(bytes);
}
/** Decode only one bounded chunk, rejecting truncated, oversized and unordered values. */
export function decodePostingIds(bytes: Uint8Array, count: number, documents: number): Uint32Array {
  if (!Number.isSafeInteger(count) || count < 1 || count > 4096)
    throw new Error('POSTING_CHUNK_COUNT');
  const result = new Uint32Array(count);
  let offset = 0,
    prior = 0;
  for (let i = 0; i < count; i++) {
    let delta = 0,
      shift = 0,
      last: number;
    do {
      if (offset >= bytes.length || shift > 28) throw new Error('POSTING_VARINT_INVALID');
      last = bytes[offset++]!;
      delta += (last & 127) * 2 ** shift;
      shift += 7;
    } while (last & 128);
    const id = prior + delta;
    if (id >= documents || (i > 0 && id <= prior)) throw new Error('POSTING_ID_INVALID');
    result[i] = id;
    prior = id;
  }
  if (offset !== bytes.length) throw new Error('POSTING_CHUNK_TRAILING_BYTES');
  return result;
}
/** Compress a bounded page once at build time. */
export function packPostingPage(bytes: Uint8Array): PostingBytes {
  return Uint8Array.from(deflateRawSync(bytes));
}
/** The reader calls this on a page-cache miss, not once per query. */
export function unpackPostingPage(value: PostingBytes, maxBytes: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength > Math.max(3, maxBytes * 2))
    throw new Error('POSTING_PAGE_INVALID');
  return new Uint8Array(inflateRawSync(value, { maxOutputLength: maxBytes }));
}
/** UTF-8 JSON is used only for cold lexicon/ID pages, never for posting-list intersections. */
export function packPostingJson(value: unknown): PostingBytes {
  return packPostingPage(new TextEncoder().encode(JSON.stringify(value)));
}

/** Encode a bounded page of chunk locations separately from the term dictionary. */
export function encodePostingDescriptors(chunks: readonly PostingChunk[]): Uint8Array {
  const bytes = new Uint8Array(chunks.length * POSTING_DESCRIPTOR_BYTES);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < chunks.length; index++)
    for (let field = 0; field < 6; field++)
      view.setUint32(index * POSTING_DESCRIPTOR_BYTES + field * 4, chunks[index]![field]!, true);
  return bytes;
}
/** Read one chunk location without materializing the rest of a hot term's directory. */
export function postingDescriptorAt(bytes: Uint8Array, index: number): PostingChunk {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offset = index * POSTING_DESCRIPTOR_BYTES;
  return [
    view.getUint32(offset, true), view.getUint32(offset + 4, true),
    view.getUint32(offset + 8, true), view.getUint32(offset + 12, true),
    view.getUint32(offset + 16, true), view.getUint32(offset + 20, true),
  ];
}
