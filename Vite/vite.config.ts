import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills';

// https://vite.dev/config/
export default defineConfig({
  // npm run dev: send Parse calls to the local Parse Server (Parse/local, port 1337)
  server: { proxy: { '/parse': 'http://127.0.0.1:1337' } },
  plugins: [
    react(),
    nodePolyfills({
      // Polyfills 'events', 'stream', 'util', etc. required by Parse
      include: ['events', 'stream', 'util', 'buffer'],
      globals: {
        process: true,
        Buffer: true,
      },
    }),
  ],
  define: {
    'process.env': {},
  },
  build: {
    commonjsOptions: {
      include: [/parse/, /node_modules/],
    },
  },
})