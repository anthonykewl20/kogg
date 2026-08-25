import { spawnSync } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

run('yarn', ['install', '--frozen-lockfile']);
run(process.execPath, ['scripts/provision-builtins.mjs']);
run('yarn', ['playwright', 'install', 'chromium']);

run('uv', ['venv', '--python', '3.12.14', '.venv']);
run('uv', [
  'pip', 'install', '--python', process.platform === 'win32'
    ? path.join(root, '.venv', 'Scripts', 'python.exe')
    : path.join(root, '.venv', 'bin', 'python'),
  'PyYAML>=6.0.2,<7', 'cryptography>=50.0.0,<51', 'packaging>=26,<27'
]);

try {
  await access(path.join(root, '.env.local'));
} catch {
  run(process.execPath, ['scripts/generate-secrets.mjs']);
}

run(process.execPath, ['scripts/doctor.mjs']);
