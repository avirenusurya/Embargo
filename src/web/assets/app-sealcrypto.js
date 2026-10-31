// Sealed-block crypto for the browser (Part 13.4), byte-compatible with src/crypto/sealedClient.ts.
// Pure WebCrypto (no DOM), so the same module also runs under Node >= 20 for interop tests.
//   body:      AES-256-GCM(DEK, utf8(plaintext), AAD "embargo-sealed-block")  -> ciphertext = b64(ct||tag), nonce = b64(12 bytes)
//   DEK wrap:  AES-256-GCM(WSK, DEK, AAD "embargo-sealed-dek")                -> wrapped_dek = b64(nonce||ct||tag)
//   recovery:  AES-256-GCM(HKDF-SHA256(b64url(recoveryKey), salt="", info "embargo-recovery"), WSK, AAD "embargo-wsk") -> b64(nonce||ct||tag)
//   device:    X25519(ephemeral, device SPKI) -> HKDF-SHA256(shared, salt="", info "embargo-device-wrap") -> AES-256-GCM(WSK, AAD "embargo-wsk")
//              -> JSON { epk: b64(SPKI DER), nonce: b64, ct: b64(ct||tag) }
const subtle = globalThis.crypto.subtle;
const te = new TextEncoder();
const td = new TextDecoder();

export const rand = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
export function b64(u8) { let s = ''; const b = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8); for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); }
export function unb64(s) { const bin = atob(String(s).replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '')); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
export const b64url = (u8) => b64(u8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const cat = (a, b) => { const o = new Uint8Array(a.length + b.length); o.set(a, 0); o.set(b, a.length); return o; };

async function aesKey(raw) { return subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']); }
async function gcm(key, data, aad) {
  const k = key instanceof Uint8Array ? await aesKey(key) : key;
  const nonce = rand(12);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: te.encode(aad), tagLength: 128 }, k, data));
  return { nonce, ct };
}
async function ungcm(key, nonce, ct, aad) {
  const k = key instanceof Uint8Array ? await aesKey(key) : key;
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: te.encode(aad), tagLength: 128 }, k, ct));
}
async function hkdf(ikm, info) {
  const k = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: te.encode(info) }, k, 256));
}

export const generateWsk = () => rand(32);
export const generateRecoveryKey = () => b64url(rand(32));

export async function encryptSealed(wsk, plaintext) {
  const dek = rand(32);
  try {
    const body = await gcm(dek, te.encode(plaintext), 'embargo-sealed-block');
    const w = await gcm(wsk, dek, 'embargo-sealed-dek');
    return { ciphertext: b64(body.ct), nonce: b64(body.nonce), wrapped_dek: b64(cat(w.nonce, w.ct)) };
  } finally { dek.fill(0); }
}
export async function decryptSealed(wsk, b) {
  const wd = unb64(b.wrapped_dek);
  const dek = await ungcm(wsk, wd.subarray(0, 12), wd.subarray(12), 'embargo-sealed-dek');
  try { return td.decode(await ungcm(dek, unb64(b.nonce), unb64(b.ciphertext), 'embargo-sealed-block')); } finally { dek.fill(0); }
}

export async function wrapWithRecovery(wsk, recoveryKey) {
  const w = await gcm(await hkdf(unb64(recoveryKey), 'embargo-recovery'), wsk, 'embargo-wsk');
  return b64(cat(w.nonce, w.ct));
}
export async function unwrapWithRecovery(wrapped, recoveryKey) {
  const b = unb64(wrapped);
  return ungcm(await hkdf(unb64(recoveryKey.trim()), 'embargo-recovery'), b.subarray(0, 12), b.subarray(12), 'embargo-wsk');
}

/** X25519 device key pair. The private key stays a non-extractable CryptoKey (storable in IndexedDB). */
export async function deviceKeypair({ extractable = false } = {}) {
  const kp = await subtle.generateKey({ name: 'X25519' }, extractable, ['deriveBits']);
  return { publicKey: b64(new Uint8Array(await subtle.exportKey('spki', kp.publicKey))), privateKey: kp.privateKey };
}
const importPub = (b64spki) => subtle.importKey('spki', unb64(b64spki), { name: 'X25519' }, true, []);
const importPriv = (b64pkcs8) => subtle.importKey('pkcs8', unb64(b64pkcs8), { name: 'X25519' }, false, ['deriveBits']);

export async function wrapToDevice(wsk, devicePublicKeyB64) {
  const eph = await subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']);
  const shared = new Uint8Array(await subtle.deriveBits({ name: 'X25519', public: await importPub(devicePublicKeyB64) }, eph.privateKey, 256));
  const w = await gcm(await hkdf(shared, 'embargo-device-wrap'), wsk, 'embargo-wsk');
  shared.fill(0);
  return JSON.stringify({ epk: b64(new Uint8Array(await subtle.exportKey('spki', eph.publicKey))), nonce: b64(w.nonce), ct: b64(w.ct) });
}
/** privateKey: a CryptoKey (browser) or a base64 PKCS8 DER string (as the local MCP package stores it). */
export async function unwrapOnDevice(wrapped, privateKey) {
  const j = JSON.parse(wrapped);
  const priv = typeof privateKey === 'string' ? await importPriv(privateKey) : privateKey;
  const shared = new Uint8Array(await subtle.deriveBits({ name: 'X25519', public: await importPub(j.epk) }, priv, 256));
  try { return await ungcm(await hkdf(shared, 'embargo-device-wrap'), unb64(j.nonce), unb64(j.ct), 'embargo-wsk'); } finally { shared.fill(0); }
}

/** Local at-rest protection for the WSK: AES-GCM under a non-extractable key that never leaves this browser profile. */
export async function newLocalWrapKey() { return subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']); }
export async function sealLocal(wrapKey, wsk) { const w = await gcm(wrapKey, wsk, 'embargo-local-wsk'); return { nonce: w.nonce, ct: w.ct }; }
export async function openLocal(wrapKey, rec) { return ungcm(wrapKey, rec.nonce, rec.ct, 'embargo-local-wsk'); }
