import { extractAll } from '@electron/asar';
import { access, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const asar = await locateAsar(process.argv[2]);
const resources = path.dirname(asar);
const temporary = await mkdtemp(path.join(os.tmpdir(), 'kogg-artifact-audit-'));
const forbidden = [
  ['public Open VSX endpoint', /https?:\/\/open-vsx\.org/iu],
  ['Theia product-name default', /(?:applicationName|productName|windowTitle)[^\n]{0,40}Eclipse Theia/iu],
  ['stock Open VSX UI', /Search Open VSX Registry|Extensions:\s*Open VSX Registry/iu],
  ['stock Workspace Trust branding', /Learn more about Theia(?:'s|’s) Workspace Trust|theia-ide\.org\/docs\/workspace_trust/iu],
  ['stock custom-agent UI', /Re-run custom-agent migration/iu]
];
const violations = [];

try {
  await requirePath(path.join(resources, 'kogg-runtime', 'python'), 'bundled Python runtime');
  await requirePath(path.join(resources, 'kogg-runtime', 'ranex', 'PROVENANCE.json'), 'Ranex provenance');
  await requirePath(path.join(resources, 'kogg-runtime', 'ranex', 'LICENSE'), 'Ranex license');
  await requirePath(path.join(resources, 'kogg-runtime', 'adapter', 'kogg_ranex_adapter.py'), 'Kogg Ranex adapter');
  await requirePath(path.join(resources, 'kogg-runtime', 'marketplace-public.pem'), 'marketplace verification key');
  await requirePath(path.join(resources, 'kogg-system-plugins', 'vscode.git', 'package.json'), 'bundled Git integration');
  await requirePath(path.join(resources, 'kogg-system-plugins', 'ms-vscode.js-debug', 'package.json'), 'bundled JavaScript debugger');
  extractAll(asar, temporary);
  await walk(temporary);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

if (violations.length) {
  console.error(violations.join('\n'));
  process.exit(1);
}
console.log(`Kogg production artifact audit passed: ${asar}`);

async function locateAsar(input) {
  if (input) {
    const target = path.resolve(input);
    const info = await stat(target);
    if (info.isFile()) return target;
    for (const candidate of [
      path.join(target, 'Contents', 'Resources', 'app.asar'),
      path.join(target, 'resources', 'app.asar'),
      path.join(target, 'app.asar')
    ]) {
      try {
        await access(candidate);
        return candidate;
      } catch { /* try the next packaged-app layout */ }
    }
    throw new Error(`No app.asar found below ${target}`);
  }

  const matches = [];
  await findAsars(path.resolve('apps', 'electron', 'dist'), matches);
  if (!matches.length) throw new Error('No packaged Kogg app found. Run yarn package:electron first.');
  if (matches.length > 1) {
    matches.sort((left, right) => right.mtimeMs - left.mtimeMs);
    console.log(`Multiple packaged apps found; auditing newest app.asar: ${matches[0].file}`);
  }
  return matches[0].file;
}

async function findAsars(directory, matches) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await findAsars(target, matches);
    else if (entry.name === 'app.asar') matches.push({ file: target, ...(await stat(target)) });
  }
}

async function requirePath(target, label) {
  try {
    await access(target);
  } catch {
    violations.push(`${path.relative(process.cwd(), target)}: missing ${label}`);
  }
}

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(target);
    else if (/\.(?:js|json|html|css)$/u.test(entry.name) && !/\.(?:test|spec)\.[cm]?[jt]s$/u.test(entry.name)) {
      const content = await readFile(target, 'utf8');
      for (const [label, pattern] of forbidden) if (pattern.test(content)) violations.push(`${path.relative(temporary, target)}: ${label}`);
    }
  }
}
