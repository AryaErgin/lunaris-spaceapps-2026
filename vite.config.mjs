import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Local editing only: the published offline application remains the web directory.
export default defineConfig({
  root: fileURLToPath(new URL('./web/', import.meta.url)),
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    open: false,
  },
});
