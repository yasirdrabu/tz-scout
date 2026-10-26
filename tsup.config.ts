import path from 'node:path';
import { defineConfig } from 'tsup';

// Builds the role dispatcher. App code is bundled (with the `@/` alias resolved); node_modules stay external.
export default defineConfig({
  entry: { cli: 'src/entry/cli.ts' },
  outDir: 'dist',
  format: ['cjs'],
  target: 'node22',
  platform: 'node',
  clean: true,
  sourcemap: true,
  esbuildOptions(options) {
    options.alias = { '@': path.resolve(__dirname, 'src') };
  },
});
