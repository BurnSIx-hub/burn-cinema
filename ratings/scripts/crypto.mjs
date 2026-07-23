/**
 * At-rest encryption for raw votes.
 *
 * The world setting stores only public aggregates in the clear plus an encrypted
 * blob of the identified per-user votes. The AES-GCM key lives in a client-scope
 * setting on the GM's machine only (localStorage, never sent over the wire), so a
 * player reading the world setting from the console sees ciphertext.
 *
 * Caveat: this protects data *at rest*. The player→GM vote still travels the
 * socket in the clear; closing that would require asymmetric (public-key) crypto.
 */

export const MODULE_ID = "session-ratings";
export const SECRET_SETTING = "secretKey"; // client scope, GM's browser only

let _cachedKey = null; // CryptoKey, cached per session

const subtle = globalThis.crypto?.subtle;

/* --------------------------------------------------------------- base64 io -- */

function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64ToBuf(b64) {
  const s = atob(b64);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u.buffer;
}

/* ------------------------------------------------------------------- keys --- */

/** Raw base64 of the key as stored/exported. Empty string if none yet. */
export function getKeyString() {
  return game.settings.get(MODULE_ID, SECRET_SETTING) ?? "";
}

/** Import (or replace) the key from a base64 string. GM only. */
export async function setKeyString(b64) {
  await game.settings.set(MODULE_ID, SECRET_SETTING, b64 ?? "");
  _cachedKey = null; // force re-import on next use
}

/** True once a key exists on this machine. */
export function hasKey() {
  return !!getKeyString();
}

/**
 * Return the CryptoKey, generating and persisting a fresh one on first use.
 * GM only (only the GM ever writes the world blob or the client-scope key).
 */
async function getKey() {
  if (_cachedKey) return _cachedKey;
  let b64 = getKeyString();
  if (!b64) {
    const key = await subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    const raw = await subtle.exportKey("raw", key);
    b64 = bufToB64(raw);
    await game.settings.set(MODULE_ID, SECRET_SETTING, b64);
    _cachedKey = key;
    return key;
  }
  _cachedKey = await subtle.importKey("raw", b64ToBuf(b64), { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);
  return _cachedKey;
}

/* ------------------------------------------------------------ encrypt/dec --- */

/**
 * Encrypt an arbitrary JSON-serialisable value.
 * @returns {Promise<string>} `${ivB64}.${cipherB64}`
 */
export async function encryptJSON(value) {
  if (!subtle) throw new Error("WebCrypto unavailable");
  const key = await getKey();
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(value ?? null));
  const cipher = await subtle.encrypt({ name: "AES-GCM", iv }, key, data);
  return `${bufToB64(iv.buffer)}.${bufToB64(cipher)}`;
}

/**
 * Decrypt a blob produced by {@link encryptJSON}.
 * @returns {Promise<any|null>} the value, or null if there is no key / it fails
 *   (e.g. wrong machine, corrupted blob).
 */
export async function decryptJSON(blob) {
  if (!subtle || !blob || typeof blob !== "string" || !blob.includes(".")) return null;
  if (!hasKey()) return null;
  try {
    const [ivB64, cipherB64] = blob.split(".");
    const key = await getKey();
    const plain = await subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(b64ToBuf(ivB64)) },
      key,
      b64ToBuf(cipherB64)
    );
    return JSON.parse(new TextDecoder().decode(plain));
  } catch (err) {
    console.warn(`${MODULE_ID} | decrypt failed`, err);
    return null;
  }
}
