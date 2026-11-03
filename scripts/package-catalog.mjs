import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
const manifest = JSON.parse(await readFile('data/catalog/manifest.json', 'utf8'));
if (manifest.kind !== 'wikihack-static') throw new Error('Run npm run data:export first.');
const child = spawn('tar', ['-czf', 'catalogue.tar.gz', '-C', 'data/catalog', '.'], { stdio: 'inherit' });
const status = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
if (status !== 0) process.exit(status || 1);
console.log('Created catalogue.tar.gz as an optional catalogue backup.');
