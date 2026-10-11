import { constants, createHash, generateKeyPairSync, privateEncrypt } from 'node:crypto';

const SHA1_PREFIX = Buffer.from('3021300906052b0e03021a05000414', 'hex');

function modInverse(a: bigint, m: bigint): bigint {
  let [oldR, r] = [a % m, m];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  return ((oldS % m) + m) % m;
}

function toLittleEndian(value: bigint, length: number): Buffer {
  const out = Buffer.alloc(length);
  let v = value;
  for (let i = 0; i < length; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export interface TestAdbKey {
  /** What a client sends in AUTH(RSAPUBLICKEY): base64 blob, a space, the comment, a NUL. */
  publicKeyText: string;
  blob: Buffer;
  keyId: string;
  sign(token: Buffer): Buffer;
}

export function makeTestAdbKey(comment = 'tester@testhost'): TestAdbKey {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 65537 });
  const jwk = publicKey.export({ format: 'jwk' });
  const n = BigInt('0x' + Buffer.from(jwk.n as string, 'base64url').toString('hex'));
  const n0inv = Number((-modInverse(n & 0xffffffffn, 1n << 32n)) & 0xffffffffn) >>> 0;
  const rr = (1n << 4096n) % n;
  const blob = Buffer.alloc(524);
  blob.writeUInt32LE(64, 0);
  blob.writeUInt32LE(n0inv, 4);
  toLittleEndian(n, 256).copy(blob, 8);
  toLittleEndian(rr, 256).copy(blob, 264);
  blob.writeUInt32LE(65537, 520);
  return {
    publicKeyText: `${blob.toString('base64')} ${comment}\0`,
    blob,
    keyId: createHash('sha256').update(blob).digest('hex'),
    sign: (token) =>
      privateEncrypt({ key: privateKey, padding: constants.RSA_PKCS1_PADDING }, Buffer.concat([SHA1_PREFIX, token])),
  };
}
