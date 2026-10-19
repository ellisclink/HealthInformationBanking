import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills';

// https://vite.dev/config/
export default defineConfig({
  // npm run dev: send Parse calls to the local Parse Server (Parse/local, port 1337)
  server: { proxy: { '/parse': 'http://127.0.0.1:1337' } },
  // npm start (Back4app Web Deployment): serves the built site from dist/. allowedHosts: true lets it answer on the
  // b4a.run address and any custom domain; unknown paths like /emergency-access fall back to index.html.
  preview: { allowedHosts: true },
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
