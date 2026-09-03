import { build } from 'esbuild'

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  outfile: 'dist/index.mjs',
  // CJS packages that do dynamic require() internally break when inlined into ESM.
  // Node loads them natively at runtime instead (they live in node_modules).
  external: ['better-sqlite3', 'dotenv', 'drizzle-kit'],
  logLevel: 'warning',
  sourcemap: false
})

console.log('esbuild bundle OK -> dist/index.mjs')
