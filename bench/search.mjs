import { performance } from 'node:perf_hooks';
import { buildPostingGeneration, PostingReader } from 'stringsearchonce';
import { kinds, makeDocuments, queries } from './fixture.mjs';
const count = Number(process.argv[2] ?? 10000);
const rows = makeDocuments(count);
const byId = new Map(rows.map(row => [row.id,row]));
const start = performance.now();
const built = buildPostingGeneration(rows, { generation: 'benchmark', kinds });
const buildMs = performance.now() - start;
let compressedBytes = 0, pages = 0;
for (const list of built.pages.values()) for (const page of list) { compressedBytes += page.byteLength; pages++; }
const reader = new PostingReader(built.manifest, {
  async readPages(generation, kind, ids) {
    return new Map(ids.map(id => [id, built.pages.get(kind)[id]]));
  },
});
const run = text => reader.search({
  text, limit:10,
  fetchSources:async ids => ids.map(id => byId.get(id)),
  getId:row => row.id,
  getNames:row => row.names,
});
const coldStart = performance.now();
await reader.open();
const openMs = performance.now()-coldStart;
for (const text of queries) await run(text);
const previousDecodes = reader.counters.chunkDecodes;
const samples = [];
const cpuStart = process.cpuUsage();
const searchStart = performance.now();
for (let repeat=0;repeat<20;repeat++) for (const text of queries) {
  const before = performance.now();
  await run(text);
  samples.push(performance.now()-before);
}
const cpu = process.cpuUsage(cpuStart);
samples.sort((a,b)=>a-b);
console.log(JSON.stringify({
  synthetic:true, node:process.version, documents:count,
  terms:built.manifest.terms, pages, compressedBytes, buildMs, openMs,
  queries:samples.length, wallMs:performance.now()-searchStart,
  cpuMs:(cpu.user+cpu.system)/1000,
  medianMs:samples[Math.ceil(samples.length*0.5)-1], p95Ms:samples[Math.ceil(samples.length*0.95)-1],
  additionalWarmChunkDecodes:reader.counters.chunkDecodes-previousDecodes, cache:reader.cacheUsage(),
},null,2));
