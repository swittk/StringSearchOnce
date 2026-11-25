import { addAbortListener } from 'node:events';
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
  const { generation, kinds, chunkIds, pageBytes, idsPerPage } = options;
  return new Promise<BuiltPostingGeneration>((resolve, reject) => {
    const worker = new Worker(workerFile, {
      workerData: { options: { generation, kinds: [...kinds], chunkIds, pageBytes, idsPerPage } },
      resourceLimits: { maxOldGenerationSizeMb: 1536 },
    });
    let settled = false;
    const finish = (error: unknown, value?: BuiltPostingGeneration) => {
      if (settled) return;
      settled = true;
      abortSubscription?.[Symbol.dispose]();
      if (value === undefined) reject(error);
      else resolve(value);
    };
    const abort = () => {
      void worker.terminate();
      finish(new Error('POSTING_BUILD_CANCELLED'));
    };
    const abortSubscription = signal && addAbortListener(signal, abort);
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
          try {
            if (index >= documents.length) {
              worker.postMessage({ type: 'build' });
              return;
            }
            // Send each ID followed by its kind/text pairs. Flat arrays keep
            // structured cloning cheap and acknowledgements pace the batches.
            const fields: string[] = [];
            const nameCounts: number[] = [];
            const end = Math.min(index + 256, documents.length);
            for (; index < end; index++) {
              const { id, names } = documents[index]!;
              fields.push(id);
              let count = 0;
              for (const { kind, text } of names) {
                fields.push(kind, text);
                count++;
              }
              nameCounts.push(count);
            }
            worker.postMessage({ type: 'rows', fields, nameCounts });
          } catch (error) {
            finish(error);
            void worker.terminate();
          }
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
