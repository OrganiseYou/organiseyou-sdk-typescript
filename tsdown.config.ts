import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  sourcemap: true,
  clean: true,
  // Declarations come from `tsc` (see the build script), so the bundler only writes JavaScript.
  dts: false,
});
