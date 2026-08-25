import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const roots = ['apps', 'packages'];
const forbidden = [
  ['public Open VSX endpoint', /https?:\/\/open-vsx\.org/iu],
  ['user-facing Theia product name', /(?:productName|applicationName|windowTitle)\s*[":=]+\s*["']Theia/iu]
];
const violations = [];

async function walk(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (['node_modules', 'lib', 'src-gen', 'dist'].includes(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(target);
    else if (!/\.test\.[cm]?[jt]sx?$/u.test(entry.name) && /\.(?:json|ts|tsx|js|mjs|html|css)$/u.test(entry.name)) {
      const text = await readFile(target, 'utf8');
      for (const [label, pattern] of forbidden) if (pattern.test(text)) violations.push(`${target}: ${label}`);
    }
  }
}

for (const root of roots) await walk(root);
if (violations.length) {
  console.error(violations.join('\n'));
  process.exit(1);
}
console.log('Kogg branding audit passed.');
