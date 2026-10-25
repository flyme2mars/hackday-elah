import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Both settings below are required for @elah/editor. The export pipeline runs
// in a module worker, and Vite's pre-bundle step rewrites the worker URL.
export default defineConfig({
  plugins: [react()],
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    // elah + mediabunny stay unbundled (worker / WebCodecs). lucide-react must be
    // prebundled: Safari fails importing its ~1600-file ESM icon barrel
    // ("Importing a module script failed").
    exclude: ['@elah/editor', '@elah/core', '@elah/react', '@elah/timeline', 'mediabunny'],
    include: ['lucide-react', 'clsx', 'tailwind-merge'],
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8765',
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
})
