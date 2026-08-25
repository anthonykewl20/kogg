import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const roots = ['apps', 'packages'];
const forbidden = [
  ['public Open VSX endpoint', /https?:\/\/open-vsx\.org/iu],
  ['user-facing Theia product name', /(?:productName|applicationName|windowTitle)\s*[":=]+\s*["']Theia/iu],
  ['stock Open VSX UI', /Search Open VSX Registry|Extensions:\s*Open VSX Registry/iu],
  ['stock Workspace Trust branding', /Learn more about Theia(?:'s|’s) Workspace Trust|theia-ide\.org\/docs\/workspace_trust/iu],
  ['stock custom-agent UI', /Re-run custom-agent migration/iu]
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
for (const target of [
  'node_modules/@theia/workspace/lib/browser/workspace-trust-service.js',
  'node_modules/@theia/workspace/lib/browser/workspace-trust-dialog.js',
  'node_modules/@theia/core/i18n/nls.json'
]) {
  const text = await readFile(target, 'utf8');
  for (const [label, pattern] of forbidden) if (pattern.test(text)) violations.push(`${target}: ${label}`);
}
if (violations.length) {
  console.error(violations.join('\n'));
  process.exit(1);
}
console.log('Kogg branding audit passed.');
