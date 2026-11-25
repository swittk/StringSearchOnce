import {
  comparePostingIds,
  encodePostingIds,
  foldPostingText,
  packPostingJson,
  packPostingPage,
  postingGrams,
  postingNameKey,
  type BuiltPostingGeneration,
  type PostingBytes,
  type PostingChunk,
  type PostingDocument,
  type PostingTerm,
} from './postingFormat';

/** Offline build inputs. Nothing here reads or changes a live collection. */
export type BuildPostingOptions = {
  generation: string;
  kinds: readonly string[];
  chunkIds?: number;
  pageBytes?: number;
  idsPerPage?: number;
};

/**
 * Build an immutable snapshot from caller-supplied rows. The caller must supply a
 * consistent snapshot; live-write capture and generation publication are separate.
 */
export function buildPostingGeneration(
  input: readonly PostingDocument[],
  options: BuildPostingOptions
): BuiltPostingGeneration {
  const { generation, kinds, chunkIds = 512, pageBytes = 32768, idsPerPage = 1024 } = options;
  if (!generation || generation.length > 160)
    throw new Error('POSTING_BUILD_OPTIONS');
  const indexedKinds = new Set(kinds);
  if (!kinds.length || indexedKinds.size !== kinds.length || indexedKinds.has(''))
    throw new Error('POSTING_BUILD_OPTIONS');
  if (!Number.isSafeInteger(chunkIds) || chunkIds < 1 || chunkIds > 4096)
    throw new Error('POSTING_BUILD_LIMITS');
  if (!Number.isSafeInteger(pageBytes) || pageBytes < chunkIds * 5 || pageBytes > 131072)
    throw new Error('POSTING_BUILD_LIMITS');
  if (!Number.isSafeInteger(idsPerPage) || idsPerPage < 1 || idsPerPage > 4096)
    throw new Error('POSTING_BUILD_LIMITS');
  const rows = [...input].sort((a, b) => comparePostingIds(a.id, b.id));
  const postings = new Map<string, number[]>();
  for (let ordinal = 0; ordinal < rows.length; ordinal++) {
    const row = rows[ordinal]!;
    if (!/^[\x21-\x7e]{1,128}$/.test(row.id) || (ordinal > 0 && rows[ordinal - 1]!.id === row.id))
      throw new Error('POSTING_SOURCE_ID_INVALID');
    const terms = new Set<string>();
    for (const name of row.names) {
      if (!indexedKinds.has(name.kind)) throw new Error('POSTING_UNKNOWN_NAME_KIND');
      const text = foldPostingText(name.text);
      if (!text) continue;
      terms.add(postingNameKey(name.kind, text));
      for (const token of text.split(/\s+/u)) if (token) terms.add('w|' + token);
      for (const width of [2, 3]) for (const gram of postingGrams(text, width)) terms.add(gram);
      for (const char of text) if (/^\p{S}$/u.test(char)) terms.add('g1|' + char);
    }
    for (const term of terms) {
      let list = postings.get(term);
      if (!list) {
        list = [];
        postings.set(term, list);
      }
      list.push(ordinal);
    }
  }
  const postingPages: PostingBytes[] = [],
    entries: PostingTerm[] = [];
  let pendingPage = new Uint8Array(pageBytes),
    usedBytes = 0;
  const flushPostingPage = () => {
    if (usedBytes) postingPages.push(packPostingPage(pendingPage.subarray(0, usedBytes)));
    pendingPage = new Uint8Array(pageBytes);
    usedBytes = 0;
  };
  for (const [term, ids] of [...postings].sort(([a], [b]) => comparePostingIds(a, b))) {
    const chunks: PostingChunk[] = [];
    for (let offset = 0; offset < ids.length; offset += chunkIds) {
      const blockIds = ids.slice(offset, offset + chunkIds),
        encoded = encodePostingIds(blockIds);
      if (usedBytes + encoded.length > pageBytes) flushPostingPage();
      chunks.push([
        postingPages.length,
        usedBytes,
        encoded.length,
        blockIds.length,
        blockIds[0]!,
        blockIds.at(-1)!,
      ]);
      pendingPage.set(encoded, usedBytes);
      usedBytes += encoded.length;
    }
    entries.push([term, ids.length, chunks]);
  }
  flushPostingPage();
  const lexiconPages: PostingBytes[] = [];
  let pageEntries: PostingTerm[] = [],
    jsonBytes = 2;
  for (const entry of entries) {
    const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
    // Size includes one separator byte. A singleton page needs two brackets.
    if (size + 1 > 262144) throw new Error('POSTING_LEXICON_ENTRY_TOO_LARGE');
    if (pageEntries.length && jsonBytes + size > 65536) {
      lexiconPages.push(packPostingJson(pageEntries));
      pageEntries = [];
      jsonBytes = 2;
    }
    pageEntries.push(entry);
    jsonBytes += size;
  }
  if (pageEntries.length) lexiconPages.push(packPostingJson(pageEntries));
  const idPages: PostingBytes[] = [];
  for (let offset = 0; offset < rows.length; offset += idsPerPage) {
    const ids: string[] = [];
    for (let index = offset; index < Math.min(rows.length, offset + idsPerPage); index++) {
      ids.push(rows[index]!.id);
    }
    idPages.push(packPostingJson(ids));
  }
  return {
    manifest: {
      format: 0,
      generation,
      documents: rows.length,
      terms: entries.length,
      kinds: [...kinds],
      lexiconPages: lexiconPages.length,
      postingPages: postingPages.length,
      idPages: idPages.length,
      idsPerPage,
    },
    pages: new Map([
      ['lexicon', lexiconPages],
      ['postings', postingPages],
      ['ids', idPages],
    ]),
  };
}
