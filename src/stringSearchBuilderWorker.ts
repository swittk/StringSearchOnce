import { parentPort, workerData } from 'node:worker_threads';
import { buildPostingGeneration, type BuildPostingOptions } from './buildPostingGeneration';
import type { PostingDocument } from './postingFormat';

/** Batch-acknowledged input keeps large JS structured clones off the main loop. */
type Request = {
  options: BuildPostingOptions;
};
type BatchMessage = { type: 'rows'; documents: PostingDocument[] };
type BuildMessage = { type: 'build' };

const documents: PostingDocument[] = [];
const input = workerData as Request;
parentPort?.on('message', (message: BatchMessage | BuildMessage) => {
  if (message.type === 'rows') {
    documents.push(...message.documents);
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
    parentPort?.postMessage({ type: 'result', ok: true, built });
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
