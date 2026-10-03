// The waitlist's encryption (D46), on the Web Crypto API alone, so the same file runs in the Next.js route, in the
// Playwright specs and in scripts/waitlist-export.mjs (Node strips the types). Hybrid encryption: each entry gets a
// fresh AES-256-GCM key that encrypts its JSON, and the team's RSA-OAEP-256 public key (waitlistKey.ts) wraps that
// AES key. Only the private key, held by the team outside the repository, unwraps it. No imports on purpose.

export const ALG = "RSA-OAEP-256+A256GCM";

/** One encrypted entry as it sits in the store: the ciphertext plus metadata that identifies nobody. */
export interface StoredEntry {
  /** The entry schema's version (waitlistEntry.ts ENTRY_SCHEMA). */
  v: number;
  alg: typeof ALG;
  /** Which public key wrapped `key`: the first 16 hex characters of SHA-256 over its SPKI bytes. */
  kid: string;
  /** The AES key, wrapped with RSA-OAEP (SHA-256), base64. */
  key: string;
  /** The 12-byte AES-GCM nonce, base64. */
  iv: string;
  /** The AES-GCM ciphertext of the entry's JSON, with its 16-byte tag, base64. */
  data: string;
  /** First sign-up and latest update, ISO 8601. */
  created: string;
  updated: string;
}

const subtle = (): SubtleCrypto => globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

function toB64(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromB64(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const toHex = (buf: ArrayBuffer): string =>
  Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

/** The DER bytes inside a PEM block ("-----BEGIN PUBLIC KEY-----" or "-----BEGIN PRIVATE KEY-----"). */
export function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  const body = pem.replace(/-----(BEGIN|END) [A-Z ]+-----/g, "").replace(/\s+/g, "");
  if (!body) throw new Error("empty PEM");
  return fromB64(body);
}

const RSA = { name: "RSA-OAEP", hash: "SHA-256" } as const;

export function importPublicKey(pem: string): Promise<CryptoKey> {
  return subtle().importKey("spki", pemToDer(pem), RSA, false, ["wrapKey", "encrypt"]);
}

export function importPrivateKey(pem: string): Promise<CryptoKey> {
  return subtle().importKey("pkcs8", pemToDer(pem), RSA, false, ["unwrapKey", "decrypt"]);
}

/** The key id stored with each entry, so a rotated key's entries can be told apart. */
export async function keyId(publicPem: string): Promise<string> {
  return toHex(await subtle().digest("SHA-256", pemToDer(publicPem))).slice(0, 16);
}

/** Encrypts `value` as JSON for the holder of the private key matching `publicPem`. */
export async function encryptJson(
  value: unknown,
  publicPem: string,
  meta: { v: number; created: string; updated: string },
): Promise<StoredEntry> {
  const pub = await importPublicKey(publicPem);
  const aes = await subtle().generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const data = await subtle().encrypt({ name: "AES-GCM", iv }, aes, enc.encode(JSON.stringify(value)));
  const key = await subtle().wrapKey("raw", aes, pub, { name: "RSA-OAEP" });
  return {
    v: meta.v,
    alg: ALG,
    kid: await keyId(publicPem),
    key: toB64(key),
    iv: toB64(iv),
    data: toB64(data),
    created: meta.created,
    updated: meta.updated,
  };
}

/** Decrypts a stored entry with the team's private key (PKCS#8 PEM). Throws if the key or the data do not match. */
export async function decryptJson<T = unknown>(stored: StoredEntry, privatePem: string): Promise<T> {
  if (stored.alg !== ALG) throw new Error(`unknown algorithm ${String(stored.alg)}`);
  const priv = await importPrivateKey(privatePem);
  const aes = await subtle().unwrapKey(
    "raw",
    fromB64(stored.key),
    priv,
    { name: "RSA-OAEP" },
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  const plain = await subtle().decrypt(
    { name: "AES-GCM", iv: fromB64(stored.iv) },
    aes,
    fromB64(stored.data),
  );
  return JSON.parse(dec.decode(plain)) as T;
}

/** HMAC-SHA256 of `value` under `salt`, hex. Used for the blob name (of the lowercased email) and the rate limit (of the IP). */
export async function hmacHex(value: string, salt: string): Promise<string> {
  const k = await subtle().importKey("raw", enc.encode(salt), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return toHex(await subtle().sign("HMAC", k, enc.encode(value)));
}

export const BLOB_PREFIX = "waitlist/";

/** Where an email's entry lives: waitlist/<HMAC-SHA256 of the lowercased email>.json. The same email always lands on
 *  the same path, so a second sign-up overwrites the first, and the path reveals nothing without the salt. */
export async function entryPath(email: string, salt: string): Promise<string> {
  return `${BLOB_PREFIX}${await hmacHex(email.trim().toLowerCase(), salt)}.json`;
}
