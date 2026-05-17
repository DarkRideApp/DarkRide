import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { createPrivateKey, createPublicKey, sign, generateKeyPairSync } from 'crypto';

export function runPluginSign(args: string[]): void {
  if (args.includes('--generate-key')) {
    return generateKeypair(args);
  }
  return signRegistry(args);
}

function generateKeypair(args: string[]): void {
  const outputIdx = args.indexOf('--output');
  const outputDir = outputIdx >= 0 ? args[outputIdx + 1] : '.';

  mkdirSync(outputDir, { recursive: true });

  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  writeFileSync(join(outputDir, 'signing-key.pem'), privateKey);
  writeFileSync(join(outputDir, 'signing-key.pub'), publicKey);

  // Output base64 DER for database import
  const pubDer = createPublicKey(publicKey).export({ type: 'spki', format: 'der' });

  console.log('Generated Ed25519 signing keypair:');
  console.log(`  Private key: ${join(outputDir, 'signing-key.pem')}`);
  console.log(`  Public key:  ${join(outputDir, 'signing-key.pub')}`);
  console.log('');
  console.log('Public key (base64 DER — for trusted_signing_keys table):');
  console.log(`  ${pubDer.toString('base64')}`);
}

function signRegistry(args: string[]): void {
  const registryPath = args.find(a => !a.startsWith('--'));
  if (!registryPath) {
    console.error('Usage: darkride plugin sign <registry.json> --key <private-key.pem> --key-id <id>');
    process.exit(1);
  }

  const keyIdx = args.indexOf('--key');
  const keyIdIdx = args.indexOf('--key-id');

  if (keyIdx < 0 || keyIdIdx < 0) {
    console.error('Required: --key <private-key.pem> --key-id <key-identifier>');
    process.exit(1);
  }

  const privateKeyPath = args[keyIdx + 1];
  const keyId = args[keyIdIdx + 1];

  const registry = JSON.parse(readFileSync(resolve(registryPath), 'utf-8'));
  const privateKeyPem = readFileSync(resolve(privateKeyPath), 'utf-8');
  const privateKey = createPrivateKey(privateKeyPem);

  if (!Array.isArray(registry.plugins)) {
    console.error('Registry must have a "plugins" array');
    process.exit(1);
  }

  // Only these fields are included in the signed canonical form.
  // Must match SIGNED_FIELDS in backend/services/plugin-verifier.ts
  const SIGNED_FIELDS = [
    'name', 'displayName', 'description', 'author', 'repo',
    'latestVersion', 'category', 'license', 'npmPackage', 'minDarkrideVersion',
    'npmShasum', 'gitRef',
  ];

  for (const plugin of registry.plugins) {
    const obj: Record<string, any> = {};
    for (const key of SIGNED_FIELDS) {
      if (key in plugin && plugin[key] !== undefined) obj[key] = plugin[key];
    }
    const canonical = JSON.stringify(obj, Object.keys(obj).sort());
    const sig = sign(null, Buffer.from(canonical), privateKey);
    plugin.signature = sig.toString('base64');
    plugin.signedBy = keyId;
  }

  writeFileSync(resolve(registryPath), JSON.stringify(registry, null, 2) + '\n');
  console.log(`Signed ${registry.plugins.length} plugin(s) with key "${keyId}"`);
}
