/**
 * Pre-bundle the Nest application before wrangler sees it.
 *
 * WHY THE BUILD IS IN TWO STAGES
 *
 * Neither bundler can do this job alone.
 *
 * wrangler's bundler honours npm "browser" fields — cloudflare/workers-sdk#9309,
 * still open — and two of our dependencies ship browser overrides that are
 * wrong for a Node-compatible runtime:
 *
 *   pino         "browser": "./browser.js"   pino-http reads pino.symbols at
 *                module scope and the browser build exports none, so importing
 *                nestjs-pino threw before a line of our code ran.
 *   iconv-lite   "./lib/streams": false      its index.js calls
 *                require("./streams")(stream_module) whenever
 *                process.versions.node exists, which under nodejs_compat it
 *                does. Mapped to an empty object that is
 *                "require_streams(...) is not a function" — thrown from
 *                body-parser's json parser, i.e. on every request with a body.
 *
 * platform: 'node' below is the whole fix: it resolves with node semantics,
 * where the "browser" field is simply not consulted. That closes the class
 * rather than shimming each offending package as it surfaces at runtime.
 *
 * Do not "help" it by pinning mainFields to ['module', 'main']. That flips pg
 * onto its esm/index.mjs wrapper, whose re-export of the CJS core leaves Pool
 * as a plain object — "Class extends value #<Object> is not a constructor",
 * thrown the first time anything touches the database.
 *
 * But esbuild alone cannot finish the job either: marking node builtins
 * external in an ESM bundle leaves `require("stream")` calls that become
 * esbuild's __require shim, which throws "Dynamic require of stream is not
 * supported". Handling node builtins on workerd is exactly what wrangler's
 * bundler does well.
 *
 * So: esbuild flattens the dependency graph into one CommonJS file with the
 * right resolution, and wrangler bundles that single file — where the only
 * specifiers left to resolve are node builtins.
 */
import { build } from 'esbuild';
import { builtinModules } from 'node:module';
import { mkdirSync, statSync } from 'node:fs';

const OUT = '.worker-build/app.cjs';
mkdirSync('.worker-build', { recursive: true });

await build({
  entryPoints: ['worker/app-entry.cjs'],
  outfile: OUT,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  // ...plus the workerd condition. pg's optional pg-cloudflare dependency
  // exports its real CloudflareSocket only under "workerd" and an empty stub
  // otherwise, and pg reaches for it whenever it detects the Workers runtime:
  // without this every query died on "CloudflareSocket is not a constructor".
  conditions: ['workerd'],
  target: 'es2022',
  external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
  alias: {
    // Nest requires these optionally; this application uses neither.
    '@nestjs/websockets/socket-module': './worker/stubs/nest-optional.js',
    '@nestjs/microservices/microservices-module': './worker/stubs/nest-optional.js',
    '@nestjs/microservices': './worker/stubs/nest-optional.js',
    // pino's node build wants sonic-boom and thread-stream — file descriptors
    // and worker threads. AppModule registers the built-in Nest logger on this
    // runtime instead, so nothing in the stub is ever reached.
    'nestjs-pino': './worker/stubs/pino-logger.js',
    // depd builds its wrappers with new Function(), which Workers refuse.
    // See worker/stubs/depd.js.
    depd: './worker/stubs/depd.js',
  },
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'warning',
});

console.log(
  `pre-bundled application: ${(statSync(OUT).size / 1024).toFixed(1)} KiB -> ${OUT}`,
);
