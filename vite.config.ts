import path from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

const root = path.dirname(fileURLToPath(import.meta.url))
const motionHook = path.join(root, 'src/host/resolveTimelineHook.ts')
const elahResolveTimeline = path.join(root, 'node_modules/@elah/core/dist/resolver/resolveTimeline.js')

// Preview, audio, and ExportWorker all import Elah's resolveTimeline. Sampling
// host keyframes here covers every frame those paths draw.
function hostMotionPlugin(): Plugin {
  return {
    name: 'host-motion',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source === 'host-motion-raw') return elahResolveTimeline
      const from = importer?.split('?')[0]?.replaceAll('\\', '/')
      if (from?.endsWith('/src/host/resolveTimelineHook.ts')) return null
      const spec = source.split('?')[0]?.replaceAll('\\', '/') ?? ''
      if (spec.endsWith('/resolver/resolveTimeline') || spec.endsWith('/resolver/resolveTimeline.js')) {
        return motionHook
      }
      return null
    },
  }
}

// Both settings below are required for @elah/editor. The export pipeline runs
// in a module worker, and Vite's pre-bundle step rewrites the worker URL.
export default defineConfig({
  plugins: [hostMotionPlugin(), react()],
  worker: {
    format: 'es',
    plugins: () => [hostMotionPlugin()],
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
