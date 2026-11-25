import { defineConfig } from 'tsdown';

// Declarations come from `tsc` (see the build script), so the bundler only writes JavaScript.
export default defineConfig([
  {
    // The package itself: no Node.js built-ins, so it runs in a browser too
    entry: ['src/index.ts'],
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    sourcemap: true,
    clean: true,
    dts: false,
  },
  {
    // The `organiseyou` command: Node.js only, with the core bundled in, so `npx organiseyou` needs nothing else
    entry: ['src/cli.ts'],
    format: 'esm',
    platform: 'node',
    target: 'node22',
    sourcemap: true,
    clean: false,
    // `.js`, as the package.json says it is a module: Node.js's platform default would be `.mjs`
    fixedExtension: false,
    dts: false,
  },
]);
