import { mkdir, mkdtemp, open, rm, unlink, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import {
  comparePostingIds, type PostingBytes, type PostingDocument,
  type PostingManifest, type PostingPageKind, type PostingPageSink,
} from './postingFormat';
import { PostingPageBuilder, type BuildPostingOptions } from './postingBuildPages';
import { collectPostingTerms } from './postingBuildTerms';

type Run = { path: string; firstOrdinal: number };

/** Buffered private spill records: UTF-16LE key bytes, count, then raw uint32 ordinals. */
class RunWriter {
  private readonly buffer: Buffer;
  private readonly io: Uint8Array;
  private readonly header = Buffer.allocUnsafe(8);
  private used = 0;
  private closed = false;
  constructor(private handle: FileHandle, size: number) {
    this.buffer = Buffer.allocUnsafe(size);
    this.io = new Uint8Array(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
  }
  private async flush(): Promise<void> {
    let at = 0;
    while (at < this.used) {
      const { bytesWritten } = await this.handle.write(this.io, at, this.used - at);
      if (!bytesWritten) throw new Error('POSTING_RUN_SHORT_WRITE');
      at += bytesWritten;
    }
    this.used = 0;
  }
  async write(bytes: Buffer): Promise<void> {
    let at = 0;
    while (at < bytes.byteLength) {
      if (this.used === this.buffer.length) await this.flush();
      const count = Math.min(bytes.byteLength - at, this.buffer.length - this.used);
      this.buffer.set(bytes.subarray(at, at + count), this.used);
      at += count; this.used += count;
    }
  }
  async startTerm(term: string, count: number): Promise<void> {
    const keyBytes = term.length * 2;
    if (this.buffer.length - this.used >= 8 + keyBytes) {
      this.buffer.writeUInt32LE(keyBytes, this.used);
      this.buffer.writeUInt32LE(count, this.used + 4);
      this.buffer.write(term, this.used + 8, keyBytes, 'utf16le');
      this.used += 8 + keyBytes;
      return;
    }
    const key = Buffer.from(term, 'utf16le');
    this.header.writeUInt32LE(key.byteLength, 0);
    this.header.writeUInt32LE(count, 4);
    await this.write(this.header);
    await this.write(key);
  }
  async writeIds(ids: readonly number[]): Promise<void> {
    let at = 0;
    while (at < ids.length) {
      if (this.buffer.length - this.used < 4) await this.flush();
      const count = Math.min(ids.length - at, (this.buffer.length - this.used) >>> 2);
      for (let i = 0; i < count; i++)
        this.buffer.writeUInt32LE(ids[at + i]!, this.used + i * 4);
      at += count; this.used += count * 4;
    }
  }
  async finish(): Promise<void> {
    try { await this.flush(); } finally { await this.close(); }
  }
  async close(): Promise<void> {
    if (!this.closed) { this.closed = true; await this.handle.close(); }
  }
}

class RunReader {
  private readonly buffer: Buffer;
  private readonly io: Uint8Array;
  private start = 0;
  private end = 0;
  private eof = false;
  term: string | undefined;
  count = 0;
  remaining = 0;
  constructor(private handle: FileHandle, size: number) {
    this.buffer = Buffer.allocUnsafe(size);
    this.io = new Uint8Array(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
  }
  private async ensure(count: number): Promise<boolean> {
    while (this.end - this.start < count && !this.eof) {
      if (this.start) this.buffer.copyWithin(0, this.start, this.end);
      this.end -= this.start; this.start = 0;
      const { bytesRead } = await this.handle.read(
        this.io, this.end, this.buffer.length - this.end
      );
      this.end += bytesRead;
      if (!bytesRead) this.eof = true;
    }
    return this.end - this.start >= count;
  }
  private async readInto(target: Buffer): Promise<void> {
    let at = 0;
    while (at < target.byteLength) {
      if (this.end === this.start && !await this.ensure(1)) throw new Error('POSTING_RUN_TRUNCATED');
      const count = Math.min(target.byteLength - at, this.end - this.start);
      target.set(this.buffer.subarray(this.start, this.start + count), at);
      at += count; this.start += count;
    }
  }
  async nextTerm(): Promise<boolean> {
    if (this.end - this.start < 8 && !await this.ensure(8)) {
      if (this.start !== this.end) throw new Error('POSTING_RUN_TRUNCATED');
      this.term = undefined;
      return false;
    }
    const keyBytes = this.buffer.readUInt32LE(this.start);
    this.count = this.buffer.readUInt32LE(this.start + 4);
    this.remaining = this.count;
    this.start += 8;
    if (this.end - this.start >= keyBytes) {
      this.term = this.buffer.toString('utf16le', this.start, this.start + keyBytes);
      this.start += keyBytes;
    } else {
      const key = Buffer.allocUnsafe(keyBytes);
      await this.readInto(key);
      this.term = key.toString('utf16le');
    }
    return true;
  }
  async copyIds(writer: RunWriter): Promise<void> {
    let bytes = this.remaining * 4;
    while (bytes) {
      if (this.end === this.start && !await this.ensure(1)) throw new Error('POSTING_RUN_TRUNCATED');
      const count = Math.min(bytes, this.end - this.start);
      await writer.write(this.buffer.subarray(this.start, this.start + count));
      this.start += count; bytes -= count;
    }
    this.remaining = 0;
  }
  async appendIds(target: number[], count: number): Promise<void> {
    while (count) {
      if (this.end - this.start < 4 && !await this.ensure(4)) throw new Error('POSTING_RUN_TRUNCATED');
      const take = Math.min(count, (this.end - this.start) >>> 2);
      for (let i = 0; i < take; i++)
        target.push(this.buffer.readUInt32LE(this.start + i * 4));
      this.start += take * 4; count -= take; this.remaining -= take;
    }
  }
  close(): Promise<void> { return this.handle.close(); }
}

type Head = { reader: RunReader; firstOrdinal: number };
function before(a: Head, b: Head): boolean {
  const order = comparePostingIds(a.reader.term!, b.reader.term!);
  return order < 0 || (!order && a.firstOrdinal < b.firstOrdinal);
}

/** Only one current term per open run is retained. */
class RunHeap {
  private items: Head[] = [];
  peek(): Head | undefined { return this.items[0]; }
  push(head: Head): void {
    let at = this.items.length;
    this.items.push(head);
    while (at) {
      const parent = (at - 1) >>> 1;
      if (!before(head, this.items[parent]!)) break;
      this.items[at] = this.items[parent]!; at = parent;
    }
    this.items[at] = head;
  }
  pop(): Head {
    const first = this.items[0]!, last = this.items.pop()!;
    if (this.items.length) {
      let at = 0;
      for (;;) {
        let child = at * 2 + 1;
        if (child >= this.items.length) break;
        if (child + 1 < this.items.length && before(this.items[child + 1]!, this.items[child]!))
          child++;
        if (!before(this.items[child]!, last)) break;
        this.items[at] = this.items[child]!; at = child;
      }
      this.items[at] = last;
    }
    return first;
  }
}


/** Resource policy for a bounded build from globally ordered documents. */
export type BuildOrderedPostingOptions = BuildPostingOptions & {
  /** Caller-owned directory; the builder creates and removes its own child. */
  scratchDirectory: string;
  /** Accounted bytes retained for one sorted run; one document is indivisible. */
  runBytes: number;
  /** Maximum simultaneous merge inputs and their file buffers. */
  mergeFanIn: number;
};

/**
 * Build an unpublished generation without retaining all documents, terms or pages.
 * IDs must be strictly increasing valid ASCII IDs. The caller publishes the
 * returned manifest only after success and removes unpublished sink output on
 * failure. This function removes only its own temporary spill directory.
 */
export async function buildPostingGenerationFromOrderedDocuments(
  input: AsyncIterable<PostingDocument>,
  options: BuildOrderedPostingOptions,
  sink: PostingPageSink
): Promise<PostingManifest> {
  const { generation, scratchDirectory, runBytes, mergeFanIn } = options;
  if (runBytes <= 0 || !Number.isSafeInteger(mergeFanIn) || mergeFanIn < 2)
    throw new Error('POSTING_BUILD_BUDGET');
  const pending: { kind: PostingPageKind; page: number; bytes: PostingBytes }[] = [];
  const builder = new PostingPageBuilder(options, (kind, page, bytes) => {
    pending.push({ kind, page, bytes });
  });
  const drain = async () => {
    for (const { kind, page, bytes } of pending)
      await sink.writePage(generation, kind, page, bytes);
    pending.length = 0;
  };
  const ioBytes = Math.max(builder.pageBytes, builder.metadataPageBytes);
  await mkdir(scratchDirectory, { recursive: true });
  const owned = await mkdtemp(join(scratchDirectory, 'posting-build-'));
  let nextRun = 0;
  const levels: Run[][] = [];
  const removeRuns = async (runs: readonly Run[]) => {
    for (const run of runs) await unlink(run.path);
  };
  const createWriter = async () => {
    const path = join(owned, 'run-' + nextRun++ + '.bin');
    const writer = new RunWriter(await open(path, 'wx'), ioBytes);
    return { path, writer };
  };
  const visitMerged = async (
    runs: readonly Run[],
    consume: (term: string, count: number, heads: readonly Head[]) => Promise<void>
  ) => {
    const readers: RunReader[] = [], heap = new RunHeap();
    try {
      for (const run of runs) {
        const reader = new RunReader(await open(run.path, 'r'), ioBytes);
        readers.push(reader);
        if (await reader.nextTerm()) heap.push({ reader, firstOrdinal: run.firstOrdinal });
      }
      while (heap.peek()) {
        const term = heap.peek()!.reader.term!, heads: Head[] = [];
        let count = 0;
        while (heap.peek()?.reader.term === term) {
          const head = heap.pop();
          heads.push(head); count += head.reader.count;
        }
        await consume(term, count, heads);
        for (const head of heads) if (await head.reader.nextTerm()) heap.push(head);
      }
    } finally {
      for (const reader of readers) await reader.close();
    }
  };
  const mergeRuns = async (runs: readonly Run[]): Promise<Run> => {
    const { path, writer } = await createWriter();
    try {
      await visitMerged(runs, async (term, count, heads) => {
        await writer.startTerm(term, count);
        for (const head of heads) await head.reader.copyIds(writer);
      });
      await writer.finish();
    } finally { await writer.close(); }
    const result = { path, firstOrdinal: runs[0]!.firstOrdinal };
    await removeRuns(runs);
    return result;
  };
  // Contiguous ordinal ranges let each same-term body merge by concatenation.
  // Levels retain fewer than fan-in runs each, instead of an unbounded run list.
  const retainRun = async (initial: Run) => {
    let run = initial, level = 0;
    for (;;) {
      const buffered = levels[level] ??= [];
      buffered.push(run);
      if (buffered.length < mergeFanIn) return;
      run = await mergeRuns(buffered);
      levels[level] = []; level++;
    }
  };
  try {
    const indexedKinds = new Set(options.kinds), postings = new Map<string, number[]>();
    let accounted = 0, firstBufferedOrdinal = 0, previousId = '';
    const flushRun = async () => {
      if (!postings.size) return;
      const { path, writer } = await createWriter();
      try {
        const terms = [...postings.keys()].sort(comparePostingIds);
        for (const term of terms) {
          const ids = postings.get(term)!;
          await writer.startTerm(term, ids.length);
          await writer.writeIds(ids);
        }
        await writer.finish();
      } finally { await writer.close(); }
      const run = { path, firstOrdinal: firstBufferedOrdinal };
      postings.clear(); accounted = 0;
      await retainRun(run);
    };
    for await (const source of input) {
      const ordinal = builder.manifest.documents;
      if (!/^[\x21-\x7e]{1,128}$/.test(source.id))
        throw new Error('POSTING_SOURCE_ID_INVALID');
      if (ordinal && source.id <= previousId)
        throw new Error('POSTING_SOURCE_ID_NOT_ORDERED');
      previousId = source.id;
      const terms = collectPostingTerms(source.names, indexedKinds);
      if (!postings.size) firstBufferedOrdinal = ordinal;
      for (const term of terms) {
        let ids = postings.get(term);
        if (!ids) {
          ids = []; postings.set(term, ids);
          // String, Map/list overhead and sort references, plus each ordinal below.
          accounted += 128 + term.length * 2;
        }
        ids.push(ordinal); accounted += 8;
      }
      builder.addId(source.id);
      if (pending.length) await drain();
      // A document's terms are the indivisible unit and can exceed the run target.
      if (accounted >= runBytes) await flushRun();
    }
    if (!nextRun) {
      // The complete posting map fits the existing run budget: emit it directly.
      // Both paths use the same page encoder and assign the same global ordinals.
      const terms = [...postings.keys()].sort(comparePostingIds);
      for (const term of terms) {
        const ids = postings.get(term)!;
        builder.beginTerm(term, ids.length);
        for (let at = 0; at < ids.length; at += builder.chunkIds) {
          builder.addChunk(ids.slice(at, at + builder.chunkIds));
          if (pending.length) await drain();
        }
        builder.endTerm();
        if (pending.length) await drain();
      }
      builder.finish();
      if (pending.length) await drain();
      return builder.manifest;
    }
    await flushRun();
    let runs: Run[] = [];
    for (const level of levels) runs.push(...level);
    runs.sort((a, b) => a.firstOrdinal - b.firstOrdinal);
    while (runs.length > mergeFanIn) {
      const next: Run[] = [];
      for (let at = 0; at < runs.length; at += mergeFanIn) {
        const group = runs.slice(at, at + mergeFanIn);
        next.push(group.length === 1 ? group[0]! : await mergeRuns(group));
      }
      runs = next;
    }
    await visitMerged(runs, async (term, count, heads) => {
      builder.beginTerm(term, count);
      const block: number[] = [];
      for (const head of heads) {
        while (head.reader.remaining) {
          await head.reader.appendIds(block, Math.min(builder.chunkIds - block.length, head.reader.remaining));
          if (block.length === builder.chunkIds) {
            builder.addChunk(block);
            if (pending.length) await drain();
            block.length = 0;
          }
        }
      }
      if (block.length) builder.addChunk(block);
      builder.endTerm();
      if (pending.length) await drain();
    });
    builder.finish();
    if (pending.length) await drain();
    await removeRuns(runs);
    return builder.manifest;
  } finally {
    await rm(owned, { recursive: true, force: true });
  }
}
