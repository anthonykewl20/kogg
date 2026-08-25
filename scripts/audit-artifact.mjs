import { extractAll } from '@electron/asar';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const app = process.argv[2] ?? path.join('apps', 'electron', 'dist', 'mac-arm64', 'Kogg.app');
const asar = path.resolve(app, 'Contents', 'Resources', 'app.asar');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'kogg-artifact-audit-'));
const forbidden = [
  ['public Open VSX endpoint', /https?:\/\/open-vsx\.org/iu],
  ['Theia product-name default', /(?:applicationName|productName|windowTitle)[^\n]{0,40}Eclipse Theia/iu]
];
const violations = [];

try {
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
