import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron/simple';

// Single source of truth for the displayed version: package.json, baked in
// at build time. The footer/About previously hardcoded the version string and
// shipped stale after a bump (founder caught it on the v1.1.0 OTA test).
const pkgVersion = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version;

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkgVersion),
  },
  plugins: [
    react(),
    electron({
      main: {
        entry: 'electron/main.ts',
      },
      preload: {
        input: 'electron/preload.ts',
      },
      renderer: {},
    }),
  ],
  server: {
    port: 5173,
    strictPort: true,
  },
});
