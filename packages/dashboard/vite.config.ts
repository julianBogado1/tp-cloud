import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: {
    // shared's dist is CommonJS, which Rollup cannot read named exports from;
    // the TypeScript source is ESM and tree-shakes down to what the bundle uses
    // (DEVICE_CONFIG_FIELDS — nothing that touches process.env).
    alias: { '@snowball/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)) },
  },
});
