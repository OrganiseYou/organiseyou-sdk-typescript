import { defineConfig } from 'tsdown';

// The end-to-end check is bundled with the source of the package, so it runs the code that is in the working folder.
export default defineConfig({
  entry: ['run.ts'],
  outDir: 'dist',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  clean: true,
  dts: false,
});
