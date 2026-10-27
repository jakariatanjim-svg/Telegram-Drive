import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const outDir = path.join(appRoot, 'dist-electron');

fs.mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [path.join(appRoot, 'electron', 'main.ts')],
  outfile: path.join(outDir, 'main.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  external: ['electron'],
  sourcemap: false,
  logLevel: 'info',
});

await build({
  entryPoints: [path.join(appRoot, 'electron', 'preload.ts')],
  outfile: path.join(outDir, 'preload.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  external: ['electron'],
  sourcemap: false,
  logLevel: 'info',
});

const wasmSrc = path.join(appRoot, 'node_modules', '@mtcute', 'wasm', 'mtcute.wasm');
if (!fs.existsSync(wasmSrc)) {
  throw new Error(`Missing mtcute.wasm at ${wasmSrc}`);
}
fs.copyFileSync(wasmSrc, path.join(outDir, 'mtcute.wasm'));
console.log('Copied mtcute.wasm -> dist-electron/mtcute.wasm');
