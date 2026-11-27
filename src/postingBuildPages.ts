import {
  POSTING_DESCRIPTOR_BYTES, POSTING_INDEX_COMPATIBILITY_VERSION,
  encodePostingDescriptors, encodePostingIds, packPostingJson, packPostingPage,
  type PostingBytes, type PostingChunk, type PostingDirectoryEntry,
  type PostingManifest, type PostingPageKind, type PostingTerm,
} from './postingFormat';
import { maxPostingPages } from './postingLimits';

/** Offline build inputs. Nothing here reads or changes a live collection. */
export type BuildPostingOptions = {
  generation: string;
  kinds: readonly string[];
  chunkIds?: number;
  pageBytes?: number;
  idsPerPage?: number;
  /** Decoded dictionary/fence page target; a long key can occupy its own page. */
  metadataPageBytes?: number;
};

/** Both builders use this bounded encoder; the caller owns where completed pages go. */
export class PostingPageBuilder {
  readonly manifest: PostingManifest;
  readonly chunkIds: number;
  readonly pageBytes: number;
  readonly metadataPageBytes: number;
  private postingBytes: Uint8Array;
  private postingUsed = 0;
  private descriptors: PostingChunk[] = [];
  private descriptorCount = 0;
  private lexicon: PostingTerm[] = [];
  private lexiconBytes = 2;
  private directory: PostingDirectoryEntry[] = [];
  private directoryBytes = 2;
  private ids: string[] = [];
  private term = '';
  private termCount = 0;
  private firstDescriptor = 0;
  private firstOrdinal = -1;
  private lastOrdinal = -1;

  constructor(
    options: BuildPostingOptions,
    private emit: (kind: PostingPageKind, page: number, bytes: PostingBytes) => void
  ) {
    const {
      generation, kinds, chunkIds = 512, pageBytes = 32768,
      idsPerPage = 1024, metadataPageBytes = 65536,
    } = options;
    if (!generation || generation.length > 160)
      throw new Error('POSTING_BUILD_OPTIONS');
    const uniqueKinds = new Set(kinds);
    if (!kinds.length || uniqueKinds.size !== kinds.length || uniqueKinds.has(''))
      throw new Error('POSTING_BUILD_OPTIONS');
    if (!Number.isSafeInteger(chunkIds) || chunkIds < 1 || chunkIds > 4096)
      throw new Error('POSTING_BUILD_LIMITS');
    if (!Number.isSafeInteger(pageBytes) || pageBytes < chunkIds * 5 || pageBytes > 131072)
      throw new Error('POSTING_BUILD_LIMITS');
    if (!Number.isSafeInteger(idsPerPage) || idsPerPage < 1 || idsPerPage > 4096)
      throw new Error('POSTING_BUILD_LIMITS');
    if (!Number.isSafeInteger(metadataPageBytes) || metadataPageBytes < 8 || metadataPageBytes > 262144)
      throw new Error('POSTING_BUILD_LIMITS');
    const descriptorsPerPage = Math.floor(pageBytes / POSTING_DESCRIPTOR_BYTES);
    if (!descriptorsPerPage) throw new Error('POSTING_BUILD_LIMITS');
    this.chunkIds = chunkIds;
    this.pageBytes = pageBytes;
    this.metadataPageBytes = metadataPageBytes;
    this.postingBytes = new Uint8Array(pageBytes);
    this.manifest = {
      format: POSTING_INDEX_COMPATIBILITY_VERSION, generation, documents: 0, terms: 0, kinds,
      directoryPages: 0, lexiconPages: 0, descriptorPages: 0, postingPages: 0, idPages: 0,
      idsPerPage, descriptorsPerPage,
    };
  }

  /** IDs arrive in the same ascending order used to assign posting ordinals. */
  addId(id: string): void {
    if (this.manifest.documents >= 0xffffffff) throw new Error('POSTING_BUILD_LIMITS');
    this.ids.push(id);
    this.manifest.documents++;
    if (this.ids.length === this.manifest.idsPerPage) this.flushIds();
  }

  /** Terms arrive in ascending UTF-16 order, each with its known total count. */
  beginTerm(term: string, count: number): void {
    this.term = term;
    this.termCount = count;
    this.firstDescriptor = this.descriptorCount;
    this.firstOrdinal = -1;
    this.lastOrdinal = -1;
  }

  /** A term's chunks contain strictly increasing ordinals, including between chunks. */
  addChunk(ids: readonly number[]): void {
    if (this.termCount === 1) {
      this.firstOrdinal = this.lastOrdinal = ids[0]!;
      return;
    }
    const encoded = encodePostingIds(ids);
    if (this.postingUsed + encoded.byteLength > this.pageBytes) this.flushPosting();
    if (this.firstOrdinal < 0) this.firstOrdinal = ids[0]!;
    this.lastOrdinal = ids.at(-1)!;
    this.descriptors.push([
      this.manifest.postingPages, this.postingUsed, encoded.byteLength,
      ids.length, ids[0]!, this.lastOrdinal,
    ]);
    this.descriptorCount++;
    if (this.descriptors.length === this.manifest.descriptorsPerPage) this.flushDescriptors();
    this.postingBytes.set(encoded, this.postingUsed);
    this.postingUsed += encoded.byteLength;
  }

  endTerm(): void {
    const header: PostingTerm = this.termCount === 1 ? [this.term, this.firstOrdinal] : [
      this.term, this.termCount, this.firstDescriptor,
      this.descriptorCount - this.firstDescriptor, this.firstOrdinal, this.lastOrdinal,
    ];
    const bytes = Buffer.byteLength(JSON.stringify(header)) + 1;
    if (bytes + 1 > 262144) throw new Error('POSTING_LEXICON_ENTRY_TOO_LARGE');
    if (this.lexicon.length && this.lexiconBytes + bytes > this.metadataPageBytes)
      this.flushLexicon();
    this.lexicon.push(header);
    this.lexiconBytes += bytes;
    this.manifest.terms++;
  }

  /** Emit the final partial pages before the caller publishes the manifest. */
  finish(): void {
    this.flushIds();
    this.flushPosting();
    this.flushDescriptors();
    this.flushLexicon();
    this.flushDirectory();
  }

  private flushIds(): void {
    if (!this.ids.length) return;
    this.emit('ids', this.manifest.idPages++, packPostingJson(this.ids));
    this.ids = [];
  }
  private flushPosting(): void {
    if (!this.postingUsed) return;
    if (this.manifest.postingPages >= maxPostingPages) throw new Error('POSTING_BUILD_LIMITS');
    this.emit('postings', this.manifest.postingPages++, packPostingPage(this.postingBytes.subarray(0, this.postingUsed)));
    this.postingBytes = new Uint8Array(this.pageBytes);
    this.postingUsed = 0;
  }
  private flushDescriptors(): void {
    if (!this.descriptors.length) return;
    this.emit('descriptors', this.manifest.descriptorPages++, packPostingPage(encodePostingDescriptors(this.descriptors)));
    this.descriptors = [];
  }
  private flushDirectory(): void {
    if (!this.directory.length) return;
    this.emit('directory', this.manifest.directoryPages++, packPostingJson(this.directory));
    this.directory = [];
    this.directoryBytes = 2;
  }
  private flushLexicon(): void {
    if (!this.lexicon.length) return;
    const page = this.manifest.lexiconPages++;
    this.emit('lexicon', page, packPostingJson(this.lexicon));
    const fence: PostingDirectoryEntry = [this.lexicon.at(-1)![0], page];
    const bytes = Buffer.byteLength(JSON.stringify(fence)) + 1;
    if (bytes + 1 > 262144) throw new Error('POSTING_DIRECTORY_ENTRY_TOO_LARGE');
    if (this.directory.length && this.directoryBytes + bytes > this.metadataPageBytes)
      this.flushDirectory();
    this.directory.push(fence);
    this.directoryBytes += bytes;
    this.lexicon = [];
    this.lexiconBytes = 2;
  }
}
