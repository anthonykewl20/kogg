// diagnostic-exempt: disposable cross-runtime prototype retained off production branches
const { createHash } = require('node:crypto');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const payload = JSON.parse(input);
  const ordered = Object.fromEntries(Object.keys(payload).sort().map(key => [key, payload[key]]));
  const canonical = Buffer.from(JSON.stringify(ordered), 'utf8');
  process.stdout.write(JSON.stringify({
    canonicalBase64: canonical.toString('base64'),
    digest: `sha256:${createHash('sha256').update(canonical).digest('hex')}`,
    runtime: 'electron-node',
    node: process.versions.node,
    electron: process.versions.electron,
    sqlite: process.versions.sqlite
  }) + '\n');
});
