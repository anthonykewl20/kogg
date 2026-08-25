import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const sentinel = 'https://registry.invalid/kogg-configuration-required';
const patches = [
  {
    file: 'node_modules/@theia/plugin-ext-vscode/lib/common/plugin-vscode-types.js',
    from: "exports.VSX_REGISTRY_URL_DEFAULT = 'https://open-vsx.org';",
    to: `exports.VSX_REGISTRY_URL_DEFAULT = '${sentinel}';`
  },
  {
    file: 'node_modules/@theia/application-package/lib/application-props.js',
    from: "applicationName: 'Eclipse Theia'",
    to: "applicationName: 'Kogg'"
  },
  {
    file: 'node_modules/@theia/workspace/lib/browser/workspace-trust-service.js',
    from: `[${'${'}nls_1.nls.localize('theia/workspace/trustLearnMore', "Learn more about Theia's Workspace Trust")}](https://theia-ide.org/docs/workspace_trust/)`,
    to: `[${'${'}nls_1.nls.localize('theia/workspace/trustLearnMore', "Learn more about Kogg Workspace Trust")}](https://github.com/anthonykewl20/kogg/blob/development/docs/workspace-trust.md)`,
    all: true
  },
  {
    file: 'node_modules/@theia/workspace/lib/browser/workspace-trust-dialog.js',
    from: `https://theia-ide.org/docs/workspace_trust/`,
    to: `https://github.com/anthonykewl20/kogg/blob/development/docs/workspace-trust.md`,
    all: true
  },
  {
    file: 'node_modules/@theia/workspace/lib/browser/workspace-trust-dialog.js',
    from: `Learn more about Theia's Workspace Trust`,
    to: `Learn more about Kogg Workspace Trust`,
    all: true
  },
  {
    file: 'node_modules/@theia/core/i18n/nls.json',
    from: `Learn more about Theia's Workspace Trust`,
    to: `Learn more about Kogg Workspace Trust`
  },
  {
    file: 'node_modules/@theia/core/i18n/nls.json',
    from: `Re-run custom-agent migration`,
    to: `Review provider configuration`,
    all: true
  },
  {
    file: 'node_modules/@theia/core/i18n/nls.json',
    from: `Search Open VSX Registry`,
    to: `Search Kogg Marketplace`,
    all: true
  },
  {
    file: 'node_modules/@theia/core/i18n/nls.json',
    from: `Open VSX Registry`,
    to: `Kogg Marketplace`,
    all: true
  },
  {
    file: 'node_modules/@theia/core/lib/common/message-rpc/rpc-protocol.js',
    from: `this.pendingRequests.forEach(pending => pending.reject(new Error(event.reason)));`,
    to: `this.pendingRequests.forEach(pending => { pending.promise.catch(() => undefined); pending.reject(new Error(event.reason)); });`
  },
  {
    file: 'node_modules/@theia/core/lib/node/main.js',
    from: `process.on('unhandledRejection', (reason, promise) => {\n    throw reason;\n});`,
    to: `process.on('unhandledRejection', (reason, promise) => {\n    if (reason instanceof Error && reason.message === 'transport error') return;\n    throw reason;\n});`
  },
  {
    file: 'node_modules/@theia/ai-core/lib/browser/frontend-prompt-customization-service.js',
    from: `AI: Re-run custom-agent migration`,
    to: `Kogg: Review provider configuration`,
    all: true,
    optional: true
  }
];

for (const patch of patches) {
  const target = path.join(root, patch.file);
  let current;
  try { current = await readFile(target, 'utf8'); }
  catch (error) {
    if (patch.optional && error?.code === 'ENOENT') continue;
    throw error;
  }
  if (!current.includes(patch.from)) {
    if (current.includes(patch.to)) continue;
    throw new Error(`Theia registry patch no longer applies to ${patch.file}`);
  }
  await writeFile(target, patch.all ? current.replaceAll(patch.from, patch.to) : current.replace(patch.from, patch.to));
}

console.log('Kogg-only Theia registry policy applied.');
