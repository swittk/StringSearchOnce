import { parentPort, workerData } from 'node:worker_threads';
import { buildPostingGeneration, type BuildPostingOptions } from './buildPostingGeneration';
import type { PostingDocument, PostingName } from './postingFormat';

/** Batch acknowledgements limit how many rows the caller sends at once. */
type Request = {
  options: BuildPostingOptions;
};
type BatchMessage = { type: 'rows'; fields: string[]; nameCounts: number[] };
type BuildMessage = { type: 'build' };

const documents: PostingDocument[] = [];
const input = workerData as Request;
parentPort?.on('message', (message: BatchMessage | BuildMessage) => {
  if (message.type === 'rows') {
    const { fields, nameCounts } = message;
    let offset = 0;
    for (const count of nameCounts) {
      const id = fields[offset++]!;
      const names: PostingName[] = [];
      for (let i = 0; i < count; i++) {
        names.push({ kind: fields[offset++]!, text: fields[offset++]! });
      }
      documents.push({ id, names });
    }
    parentPort?.postMessage({ type: 'ack' });
    return;
  }
  if (message.type !== 'build') {
    parentPort?.postMessage({
      type: 'result',
      ok: false,
      message: 'POSTING_BUILD_UNKNOWN_MESSAGE',
    });
    parentPort?.close();
    return;
  }
  try {
    const built = buildPostingGeneration(documents, input.options);
    const buffers: ArrayBuffer[] = [];
    // Every packed page owns its buffer, and the worker is done with the pages.
    for (const pages of built.pages.values()) {
      for (const page of pages) buffers.push(page.buffer as ArrayBuffer);
    }
    parentPort?.postMessage({ type: 'result', ok: true, built }, buffers);
  } catch (error) {
    parentPort?.postMessage({
      type: 'result',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }
  parentPort?.close();
});
parentPort?.postMessage({ type: 'ready' });
