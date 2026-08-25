import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const [, , command, ...args] = process.argv;
if (!command) {
  throw new Error('usage: run-with-env <command> [args...]');
}

const env = { ...process.env };
try {
  const contents = await readFile(path.join(process.cwd(), '.env.local'), 'utf8');
  for (const line of contents.split(/\r?\n/u)) {
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator);
    if (env[key] === undefined) env[key] = line.slice(separator + 1);
  }
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

const child = spawn(command, args, { stdio: 'inherit', env, shell: false });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exitCode = code ?? 1;
});
