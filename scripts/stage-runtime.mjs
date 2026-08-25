import { spawnSync } from 'node:child_process';
import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd().endsWith(path.join('apps', 'electron'))
  ? path.resolve(process.cwd(), '../..')
  : process.cwd();
const destination = path.join(root, 'apps', 'electron', 'resources', 'generated', 'kogg-runtime');
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });

const located = spawnSync('uv', ['python', 'find', '--system', '--resolve-links', '3.12.14'], { encoding: 'utf8' });
if (located.status !== 0) throw new Error(`Cannot locate pinned Python: ${located.stderr}`);
const executable = located.stdout.trim();
const pythonRoot = process.platform === 'win32'
  ? path.dirname(executable)
  : path.resolve(executable, '..', '..');
await cp(pythonRoot, path.join(destination, 'python'), { recursive: true, dereference: false });
await cp(path.join(root, 'vendor', 'ranex'), path.join(destination, 'ranex'), { recursive: true });
await cp(
  path.join(root, 'packages', 'kogg-kernel', 'python'),
  path.join(destination, 'adapter'),
  { recursive: true }
);
await cp(
  process.env.KOGG_MARKETPLACE_PUBLIC_KEY ?? path.join(root, '.kogg', 'dev', 'marketplace-public.pem'),
  path.join(destination, 'marketplace-public.pem')
);

const sitePackages = process.platform === 'win32'
  ? path.join(root, '.venv', 'Lib', 'site-packages')
  : path.join(root, '.venv', 'lib', 'python3.12', 'site-packages');
const bundledSitePackages = process.platform === 'win32'
  ? path.join(destination, 'python', 'Lib', 'site-packages')
  : path.join(destination, 'python', 'lib', 'python3.12', 'site-packages');
await cp(sitePackages, bundledSitePackages, {
  recursive: true,
  force: true
});
console.log(`Staged the self-contained Kogg runtime at ${destination}`);
