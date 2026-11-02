import { defineConfig } from 'vite';

/** Dev: Vite serves the client on all interfaces; the game server runs on 2567. */
export default defineConfig({
  server: {
    host: true,
    port: 5173,
    proxy: { '/api': 'http://localhost:2567' },
  },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
});
