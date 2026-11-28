import { packPostingPage } from './postingFormat';

export type PostingObjectIdPage = { bytes: Buffer; offsets: Uint32Array };

/** One length byte per ID, followed by its printable ASCII bytes. */
export function packPostingObjectIds(ids: readonly string[]): Uint8Array {
  let size = ids.length;
  for (const id of ids) size += id.length;
  const bytes = new Uint8Array(size);
  let offset = ids.length;
  for (let index = 0; index < ids.length; index++) {
    const id = ids[index]!;
    bytes[index] = id.length;
    for (let character = 0; character < id.length; character++)
      bytes[offset++] = id.charCodeAt(character);
  }
  return packPostingPage(bytes);
}

/** Read length offsets; builders already validate ASCII IDs and their strict order. */
export function decodePostingObjectIds(raw: Uint8Array, count: number): PostingObjectIdPage {
  if (raw.byteLength < count) throw new Error('POSTING_OBJECT_IDS_INVALID');
  const offsets = new Uint32Array(count + 1);
  let offset = count;
  offsets[0] = offset;
  for (let index = 0; index < count; index++) {
    const length = raw[index]!;
    if (length < 1 || length > 128 || offset + length > raw.byteLength)
      throw new Error('POSTING_OBJECT_IDS_INVALID');
    offset += length;
    offsets[index + 1] = offset;
  }
  if (offset !== raw.byteLength) throw new Error('POSTING_OBJECT_IDS_INVALID');
  return { bytes: Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength), offsets };
}

export function postingObjectIdAt(page: PostingObjectIdPage, index: number): string {
  return page.bytes.toString('latin1', page.offsets[index]!, page.offsets[index + 1]!);
}
