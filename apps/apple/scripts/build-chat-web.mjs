import { build } from 'esbuild';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const out = path.join(root, 'apps/apple/iPhone/ChatWeb');
await mkdir(out, { recursive: true });
await build({ absWorkingDir: root, entryPoints: ['apps/apple/ChatWeb/transcript.tsx'], outfile: path.join(out, 'transcript.js'), bundle: true, minify: true, platform: 'browser', target: 'safari17', jsx: 'automatic', alias: { 'next/link': './apps/apple/ChatWeb/link.tsx' }, define: { 'process.env.NODE_ENV': '"production"' }, legalComments: 'linked' });
// Scope Tailwind to the renderer sources. Never scan the generated JS bundle.
const license = path.join(out, 'transcript.js.LEGAL.txt');
await writeFile(license, (await readFile(license, 'utf8')).replace(/[ \t]+$/gm, ''));
const theme = (await readFile(path.join(root, 'src/app/globals.css'), 'utf8')).replace('@import "tailwindcss";', '@import "tailwindcss" source(none);');
const source = theme + '\n' + await readFile(path.join(root, 'apps/apple/ChatWeb/transcript.css'), 'utf8');
const css = await postcss([tailwind({ base: root, optimize: true })]).process(source, { from: path.join(root, 'apps/apple/ChatWeb/transcript.css') });
await writeFile(path.join(out, 'transcript.css'), css.css);
await writeFile(path.join(out, 'index.html'), `<!doctype html><html class="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=5"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src https: data: blob:; frame-src about:; connect-src 'none'; font-src 'none'; base-uri 'none'; form-action 'none'"><link rel="stylesheet" href="transcript.css"></head><body><div id="root"></div><script src="transcript.js"></script></body></html>`);
console.log('Built offline chat transcript with shared web components');
