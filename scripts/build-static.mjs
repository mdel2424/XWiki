import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const database = process.env.WIKIHACK_DB || path.join(root, '.data/wikihack.sqlite');
const reuse = process.argv.includes('--reuse-data');
const catalog = path.join(root, 'data/catalog');
if (!reuse && existsSync(database)) {
  console.log('Exporting the static catalogue from the local archive…');
  const python = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const binary = existsSync(python) ? python : process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const child = spawn(binary, ['-m', 'pipeline.cli', '--db', database, 'export', '--output', catalog], { cwd: root, stdio: 'inherit' });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  if (code !== 0) process.exit(code || 1);
}
let manifest;
try { manifest = JSON.parse(await readFile(path.join(catalog, 'manifest.json'), 'utf8')); }
catch { throw new Error('No static catalogue at data/catalog. Restore the committed data or import the archive and run npm run data:export.'); }
if (manifest.kind !== 'wikihack-static' || !manifest.articleCount) throw new Error('Refusing to build an empty catalogue.');
const destination = path.join(root, 'dist');
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
for (const item of ['index.html', 'site.webmanifest', 'style.css', 'src', 'images', 'data']) await cp(path.join(root, item), path.join(destination, item), { recursive: true });
await writeFile(path.join(destination, '.nojekyll'), '');
let bytes = 0, count = 0;
async function measure(directory) {
  const { readdir } = await import('node:fs/promises');
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name);
    if (item.isDirectory()) await measure(file);
    else { bytes += (await stat(file)).size; count++; }
  }
}
await measure(destination);
if (bytes > 950_000_000) throw new Error(`Site is too large for the configured GitHub Pages budget: ${bytes} bytes.`);
console.log(`Built dist/: ${manifest.articleCount.toLocaleString()} articles, ${manifest.mentionCount.toLocaleString()} mentions, ${count.toLocaleString()} files, ${(bytes / 1e6).toFixed(1)} MB. No application server required.`);
