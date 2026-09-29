import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'

// CJS packages that do dynamic require() internally break when inlined into ESM.
// Node loads them natively at runtime instead (they live in node_modules).
//
// zod must stay external too. Inlining it makes esbuild wrap zod's ESM modules in
// lazy `__esm` initialisers, so zod's own `custom()` helper — a hoisted top-level
// function — can run before the `__esm` body that assigns `ZodCustom` has been
// called. `@modelcontextprotocol/sdk` calls `z.custom()` at module top level (its
// `types.js` builds AssertObjectSchema eagerly), so the crash landed on SDK import:
// "TypeError: Class2 is not a constructor". Loading zod natively hands it to Node's
// real ESM loader, which preserves declaration order.
// The runtime image installs these (see Dockerfile).
export const bundleExternals = [
  'better-sqlite3',
  'dotenv',
  'drizzle-kit',
  'ai',
  '@ai-sdk/*',
  '@vercel/oidc',
  'zod',
  'zod/*'
]

// Exported so the regression guard can build the exact production bundle rather
// than re-declaring these options (see scripts/verify-bundle.test.ts).
export const bundleOptions = {
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  outfile: 'dist/index.mjs',
  external: bundleExternals,
  logLevel: 'warning',
  sourcemap: false
}

// Build only when run directly (pnpm build:prod, Dockerfile), not on import.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await build(bundleOptions)
  console.log('esbuild bundle OK -> dist/index.mjs')
}
