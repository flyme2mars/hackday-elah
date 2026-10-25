const HAS_EXT = /\.(?:js|mjs|cjs|json|node|ts|tsx|css|wasm)$/i

export async function resolve(specifier, context, nextResolve) {
  const bare = specifier.split('?')[0]
  const relative = bare.startsWith('.') || bare.startsWith('/') || bare.startsWith('file:')
  if (relative && !HAS_EXT.test(bare)) {
    for (const suffix of ['.js', '/index.js']) {
      try {
        return await nextResolve(`${specifier}${suffix}`, context)
      } catch {
        /* The next suffix, or the original specifier, may still resolve. */
      }
    }
  }
  return nextResolve(specifier, context)
}
