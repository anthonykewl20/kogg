import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const secretDir = path.join(root, '.kogg', 'dev');
const envPath = path.join(root, '.env.local');
const privateKeyPath = path.join(secretDir, 'marketplace-private.pem');
const publicKeyPath = path.join(secretDir, 'marketplace-public.pem');

await mkdir(secretDir, { recursive: true, mode: 0o700 });

const exists = async file => {
  try {
    await access(file, constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

if (!(await exists(privateKeyPath)) || !(await exists(publicKeyPath))) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
  });
  await writeFile(privateKeyPath, privateKey, { mode: 0o600 });
  await writeFile(publicKeyPath, publicKey, { mode: 0o644 });
}

if (!(await exists(envPath))) {
  const authToken = randomBytes(32).toString('base64url');
  const masterKey = randomBytes(32).toString('base64url');
  const env = [
    `KOGG_AUTH_TOKEN=${authToken}`,
    `KOGG_MASTER_KEY=${masterKey}`,
    'KOGG_REGISTRY_URL=http://127.0.0.1:3100',
    'KOGG_MARKETPLACE_PUBLIC_KEY_PATH=.kogg/dev/marketplace-public.pem',
    'KOGG_STATE_DIR=.kogg/state',
    ''
  ].join('\n');
  await writeFile(envPath, env, { mode: 0o600 });
} else {
  await readFile(envPath, 'utf8');
}

console.log('Local Kogg credentials and marketplace signing keys are ready.');
