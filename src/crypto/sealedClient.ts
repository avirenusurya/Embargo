/**
 * Client-side crypto for sealed blocks (Part 13.4). Runs only on user devices (local MCP package; the browser
 * uses the same formats via WebCrypto). Embargo's servers never see the WSK or plaintext.
 */
import crypto from 'node:crypto';

const gcm = (key: Buffer, data: Buffer, aad: string) => {
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce); c.setAAD(Buffer.from(aad));
  return { nonce, ct: Buffer.concat([c.update(data), c.final(), c.getAuthTag()]) };
};
const ungcm = (key: Buffer, nonce: Buffer, ct: Buffer, aad: string) => {
  const d = crypto.createDecipheriv('aes-256-gcm', key, nonce); d.setAAD(Buffer.from(aad)); d.setAuthTag(ct.subarray(ct.length - 16));
  return Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
};
const hk = (ikm: Buffer, info: string) => Buffer.from(crypto.hkdfSync('sha256', ikm, Buffer.alloc(0), Buffer.from(info), 32));

export const generateWsk = () => crypto.randomBytes(32);
export const generateRecoveryKey = () => crypto.randomBytes(32).toString('base64url');

export function encryptSealed(wsk: Buffer, plaintext: string) {
  const dek = crypto.randomBytes(32);
  const body = gcm(dek, Buffer.from(plaintext, 'utf8'), 'embargo-sealed-block');
  const w = gcm(wsk, dek, 'embargo-sealed-dek');
  dek.fill(0);
  return { ciphertext: body.ct.toString('base64'), nonce: body.nonce.toString('base64'), wrapped_dek: Buffer.concat([w.nonce, w.ct]).toString('base64') };
}
export function decryptSealed(wsk: Buffer, b: { ciphertext: string; nonce: string; wrapped_dek: string }) {
  const wd = Buffer.from(b.wrapped_dek, 'base64');
  const dek = ungcm(wsk, wd.subarray(0, 12), wd.subarray(12), 'embargo-sealed-dek');
  try { return ungcm(dek, Buffer.from(b.nonce, 'base64'), Buffer.from(b.ciphertext, 'base64'), 'embargo-sealed-block').toString('utf8'); } finally { dek.fill(0); }
}

export function wrapWithRecovery(wsk: Buffer, recoveryKey: string) {
  const w = gcm(hk(Buffer.from(recoveryKey, 'base64url'), 'embargo-recovery'), wsk, 'embargo-wsk');
  return Buffer.concat([w.nonce, w.ct]).toString('base64');
}
export function unwrapWithRecovery(wrapped: string, recoveryKey: string) {
  const b = Buffer.from(wrapped, 'base64');
  return ungcm(hk(Buffer.from(recoveryKey, 'base64url'), 'embargo-recovery'), b.subarray(0, 12), b.subarray(12), 'embargo-wsk');
}

/** Device keys (X25519). The existing device encrypts the WSK to a new device's public key after user approval. */
export function deviceKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  return { publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64') };
}
export function wrapToDevice(wsk: Buffer, devicePublicKeyB64: string) {
  const eph = crypto.generateKeyPairSync('x25519');
  const peer = crypto.createPublicKey({ key: Buffer.from(devicePublicKeyB64, 'base64'), format: 'der', type: 'spki' });
  const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: peer });
  const w = gcm(hk(shared, 'embargo-device-wrap'), wsk, 'embargo-wsk');
  return JSON.stringify({ epk: eph.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), nonce: w.nonce.toString('base64'), ct: w.ct.toString('base64') });
}
export function unwrapOnDevice(wrapped: string, privateKeyB64: string) {
  const j = JSON.parse(wrapped);
  const priv = crypto.createPrivateKey({ key: Buffer.from(privateKeyB64, 'base64'), format: 'der', type: 'pkcs8' });
  const shared = crypto.diffieHellman({ privateKey: priv, publicKey: crypto.createPublicKey({ key: Buffer.from(j.epk, 'base64'), format: 'der', type: 'spki' }) });
  return ungcm(hk(shared, 'embargo-device-wrap'), Buffer.from(j.nonce, 'base64'), Buffer.from(j.ct, 'base64'), 'embargo-wsk');
}
