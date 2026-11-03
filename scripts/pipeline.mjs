import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const venvPython = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const systemPython = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const args = process.argv.slice(2);
function run(binary, arguments_) {
  const result = spawnSync(binary, arguments_, { cwd: root, stdio: 'inherit' });
  if (result.error) { console.error(result.error.message); process.exit(1); }
  if (result.status !== 0) process.exit(result.status || 1);
}
if (args[0] === 'setup') {
  if (!existsSync(venvPython)) run(systemPython, ['-m', 'venv', '.venv']);
  run(venvPython, ['-m', 'pip', 'install', '-r', 'pipeline/requirements.txt']);
} else {
  const db = process.env.WIKIHACK_DB || '.data/wikihack.sqlite';
  run(existsSync(venvPython) ? venvPython : systemPython, ['-m', 'pipeline.cli', '--db', db, ...args]);
}
