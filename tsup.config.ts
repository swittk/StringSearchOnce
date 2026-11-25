import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/stringSearchBuilderWorker.ts'],
  format: ['esm', 'cjs'],
  target: 'node18.18',
  platform: 'node',
  dts: { entry: 'src/index.ts' },
  splitting: false,
  clean: true,
  shims: true,
});
