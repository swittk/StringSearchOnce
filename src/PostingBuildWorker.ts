import { Worker } from 'node:worker_threads';
import { extname, join } from 'node:path';
import type { PostingDocument, BuiltPostingGeneration } from './postingFormat';
import type { BuildPostingOptions } from './buildPostingGeneration';

/**
 * Build a posting generation away from the calling event loop. The published
 * package contains the worker entrypoint.
 */
export async function buildPostingGenerationInWorker(
  documents: readonly PostingDocument[],
  options: BuildPostingOptions,
  signal?: AbortSignal
): Promise<BuiltPostingGeneration> {
  if (signal?.aborted) throw new Error('POSTING_BUILD_CANCELLED');
  const workerFile = join(__dirname, 'stringSearchBuilderWorker' + extname(__filename));
  return new Promise<BuiltPostingGeneration>((resolve, reject) => {
    const worker = new Worker(workerFile, {
      workerData: { options },
      resourceLimits: { maxOldGenerationSizeMb: 1536 },
    });
    let settled = false;
    const finish = (error?: Error, value?: BuiltPostingGeneration) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(value!);
    };
    const abort = () => {
      void worker.terminate();
      finish(new Error('POSTING_BUILD_CANCELLED'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    let index = 0;
    worker.on(
      'message',
      (reply: {
        type: 'ready' | 'ack' | 'result';
        ok?: boolean;
        built?: BuiltPostingGeneration;
        message?: string;
      }) => {
        if (settled) return;
        if (reply.type === 'ready' || reply.type === 'ack') {
          // Only 256 small source records are cloned in any event-loop turn;
          // Worker acknowledgements provide backpressure without timers.
          if (index < documents.length) {
            const next = documents.slice(index, index + 256);
            index += next.length;
            worker.postMessage({ type: 'rows', documents: next });
          } else worker.postMessage({ type: 'build' });
          return;
        }
        if (reply.type === 'result' && reply.ok && reply.built) finish(undefined, reply.built);
        else finish(new Error(reply.message ?? 'POSTING_BUILD_WORKER_FAILED'));
      }
    );
    worker.on('error', (error) => finish(error));
    worker.on('exit', (code) => {
      if (!settled) finish(new Error('POSTING_BUILD_WORKER_EXIT_' + code));
    });
    if (signal?.aborted) abort();
  });
}
