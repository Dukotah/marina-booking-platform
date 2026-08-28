/**
 * Bundle the API into a single runnable file.
 *
 * Why bundle rather than just `tsc`: the shared `@marina/*` packages deliberately ship
 * TypeScript SOURCE (`main` points at `src/index.ts`) because the Next apps consume them
 * through a webpack `extensionAlias` that maps the NodeNext `.js` specifiers back to
 * `.ts` — see DECISIONS D-008 and D-009. Plain `tsc` output kept those same specifiers,
 * so `node dist/index.js` died on
 *   ERR_MODULE_NOT_FOUND .../packages/database/src/client.js
 * and the API was only ever runnable through tsx. That made Phase 6 cutover impossible.
 *
 * Making every package emit its own JS would work too, but it changes how the Next apps
 * resolve them and adds a build-order dependency to every consumer. Bundling keeps that
 * arrangement untouched: the workspace packages get inlined here, and nothing else in the
 * repo has to change.
 *
 * Real npm dependencies stay EXTERNAL. Bundling them would be wrong for `@prisma/client`
 * (it loads a platform-specific query-engine binary at runtime by path) and pointless for
 * the rest, which are installed alongside in production anyway.
 */
import { build } from 'esbuild';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('./package.json');

/**
 * Everything the API depends on except the workspace packages. Derived from
 * package.json rather than hand-listed, so a new dependency cannot silently get
 * inlined — and `@prisma/client` is named explicitly because it arrives transitively
 * through @marina/database, which IS bundled.
 */
const external = [
  ...Object.keys(pkg.dependencies ?? {}).filter((d) => !d.startsWith('@marina/')),
  '@prisma/client',
  '.prisma/client',
];

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  external,
  /**
   * CJS interop shim. react-dom's server renderer (reached through @marina/emails)
   * does a dynamic `require('stream')` at runtime. In an ESM bundle esbuild replaces
   * that with a stub that throws "Dynamic require of \"stream\" is not supported",
   * which silently killed every rendered email — the error sink caught it the moment
   * it was wired. Recreating a real `require` from import.meta.url makes those calls
   * work exactly as they do under tsx.
   */
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "import { fileURLToPath as __fileURLToPath } from 'node:url';",
      "import { dirname as __dirname_ } from 'node:path';",
      'const require = __createRequire(import.meta.url);',
      'const __filename = __fileURLToPath(import.meta.url);',
      'const __dirname = __dirname_(__filename);',
    ].join(String.fromCharCode(10)),
  },
  sourcemap: true,
  // Keep it readable: this is a server bundle, not something shipped over the wire,
  // and a legible stack trace in production is worth more than the bytes.
  minify: false,
  logLevel: 'info',
  // The shared packages are ESM with NodeNext `.js` specifiers pointing at `.ts` files.
  // This is the bundler-side equivalent of the Next apps' webpack extensionAlias.
  resolveExtensions: ['.ts', '.tsx', '.mts', '.js', '.mjs', '.json'],
  plugins: [
    {
      name: 'ts-specifier-alias',
      setup(b) {
        // Rewrite a relative `./foo.js` to `./foo.ts` when only the .ts exists.
        b.onResolve({ filter: /^\.{1,2}\/.*\.js$/ }, async (args) => {
          const { existsSync } = await import('node:fs');
          const { resolve, dirname } = await import('node:path');
          const asTs = resolve(args.resolveDir, args.path.replace(/\.js$/, '.ts'));
          if (existsSync(asTs)) return { path: asTs };
          const asTsx = resolve(args.resolveDir, args.path.replace(/\.js$/, '.tsx'));
          if (existsSync(asTsx)) return { path: asTsx };
          void dirname;
          return null;
        });
      },
    },
  ],
});
