import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const sentinel = 'https://registry.invalid/kogg-configuration-required';
const patches = [
  {
    file: 'node_modules/@theia/vsx-registry/lib/node/vsx-environment-impl.js',
    from: "process.env['VSX_REGISTRY_URL']?.trim() || 'https://open-vsx.org'",
    to: `process.env['VSX_REGISTRY_URL']?.trim() || process.env['KOGG_REGISTRY_URL']?.trim() || '${sentinel}'`
  },
  {
    file: 'node_modules/@theia/plugin-ext-vscode/lib/common/plugin-vscode-types.js',
    from: "exports.VSX_REGISTRY_URL_DEFAULT = 'https://open-vsx.org';",
    to: `exports.VSX_REGISTRY_URL_DEFAULT = '${sentinel}';`
  },
  {
    file: 'node_modules/@theia/application-package/lib/application-props.js',
    from: "applicationName: 'Eclipse Theia'",
    to: "applicationName: 'Kogg'"
  }
];

for (const patch of patches) {
  const target = path.join(root, patch.file);
  const current = await readFile(target, 'utf8');
  if (current.includes(patch.to)) continue;
  if (!current.includes(patch.from)) throw new Error(`Theia registry patch no longer applies to ${patch.file}`);
  await writeFile(target, current.replace(patch.from, patch.to));
}

console.log('Kogg-only Theia registry policy applied.');
