import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Envelope encryption for the RSA private signing key at rest. The key material is the system's
// master credential (forging it mints valid tokens for any tenant/role), so we never store it
// plaintext: it is sealed with AES-256-GCM under a KEK held OUTSIDE the database (SIGNING_KEY_KEK).
// A DB-only leak then yields ciphertext that is useless without the KEK.

const PREFIX = "gcm.v1:";
const KEK_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM standard nonce

/** True if the stored value is a sealed blob (vs a legacy plaintext JWK string). */
export function isSealed(stored: string): boolean {
  return stored.startsWith(PREFIX);
}

function decodeKek(kekBase64: string): Buffer {
  const kek = Buffer.from(kekBase64, "base64");
  if (kek.length !== KEK_BYTES) {
    throw new Error(`SIGNING_KEY_KEK must be ${KEK_BYTES} bytes base64-encoded (got ${kek.length})`);
  }
  return kek;
}

/** Seal a plaintext private JWK string into `gcm.v1:<iv>:<ct>:<tag>` (all base64). */
export function sealPrivateJwk(plaintext: string, kekBase64: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", decodeKek(kekBase64), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64")}:${ct.toString("base64")}:${tag.toString("base64")}`;
}

/**
 * Open a stored private JWK. Sealed blobs are decrypted (KEK required); legacy plaintext rows are
 * returned as-is so existing keys keep working through the migration to encryption-at-rest.
 */
export function openPrivateJwk(stored: string, kekBase64: string | undefined): string {
  if (!isSealed(stored)) return stored;
  if (!kekBase64) throw new Error("SIGNING_KEY_KEK is required to decrypt the stored signing key");
  const [, ivB64, ctB64, tagB64] = stored.split(":");
  if (!ivB64 || !ctB64 || !tagB64) throw new Error("Malformed sealed signing key");
  const decipher = createDecipheriv("aes-256-gcm", decodeKek(kekBase64), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
}
