import {
  comparePostingIds, type BuiltPostingGeneration, type PostingBytes,
  type PostingDocument, type PostingPageKind,
} from './postingFormat';
import { collectPostingTerms } from './postingBuildTerms';
import { PostingPageBuilder, type BuildPostingOptions } from './postingBuildPages';
export type { BuildPostingOptions } from './postingBuildPages';

/**
 * Build an immutable snapshot from caller-supplied rows. This array API retains
 * the whole posting map and output; use the ordered-stream builder for bounded
 * memory. Live-write capture and generation publication belong to the caller.
 */
export function buildPostingGeneration(
  input: readonly PostingDocument[],
  options: BuildPostingOptions
): BuiltPostingGeneration {
  const pages = new Map<PostingPageKind, PostingBytes[]>([
    ['directory', []], ['lexicon', []], ['descriptors', []], ['postings', []], ['ids', []],
  ]);
  const builder = new PostingPageBuilder(options, (kind, page, bytes) => {
    pages.get(kind)![page] = bytes;
  });
  const rows = [...input].sort((a, b) => comparePostingIds(a.id, b.id));
  const indexedKinds = new Set(options.kinds);
  const postings = new Map<string, number[]>();
  for (let ordinal = 0; ordinal < rows.length; ordinal++) {
    const row = rows[ordinal]!;
    if (!/^[\x21-\x7e]{1,128}$/.test(row.id) || (ordinal > 0 && rows[ordinal - 1]!.id === row.id))
      throw new Error('POSTING_SOURCE_ID_INVALID');
    builder.addId(row.id);
    for (const term of collectPostingTerms(row.names, indexedKinds)) {
      let list = postings.get(term);
      if (!list) { list = []; postings.set(term, list); }
      list.push(ordinal);
    }
  }
  const terms = [...postings.keys()].sort(comparePostingIds);
  for (const term of terms) {
    const ids = postings.get(term)!;
    builder.beginTerm(term, ids.length);
    for (let offset = 0; offset < ids.length; offset += builder.chunkIds)
      builder.addChunk(ids.slice(offset, offset + builder.chunkIds));
    builder.endTerm();
  }
  builder.finish();
  return { manifest: builder.manifest, pages };
}
