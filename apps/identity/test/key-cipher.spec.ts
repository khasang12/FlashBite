import { randomBytes } from "node:crypto";
import { isSealed, openPrivateJwk, sealPrivateJwk } from "../src/auth/key-cipher";

const KEK = Buffer.alloc(32, 7).toString("base64");
const PLAINTEXT = JSON.stringify({ kty: "RSA", d: "secret-private-component" });

describe("key-cipher (envelope encryption of the signing key)", () => {
  it("seals to a versioned blob that does not expose the plaintext, then opens back", () => {
    const sealed = sealPrivateJwk(PLAINTEXT, KEK);
    expect(isSealed(sealed)).toBe(true);
    expect(sealed.startsWith("gcm.v1:")).toBe(true);
    expect(sealed).not.toContain("secret-private-component");
    expect(openPrivateJwk(sealed, KEK)).toBe(PLAINTEXT);
  });

  it("produces a fresh IV each call (ciphertexts differ for the same input)", () => {
    expect(sealPrivateJwk(PLAINTEXT, KEK)).not.toBe(sealPrivateJwk(PLAINTEXT, KEK));
  });

  it("returns legacy plaintext rows unchanged, even without a KEK", () => {
    expect(isSealed(PLAINTEXT)).toBe(false);
    expect(openPrivateJwk(PLAINTEXT, undefined)).toBe(PLAINTEXT);
  });

  it("refuses to open a sealed blob without the KEK", () => {
    const sealed = sealPrivateJwk(PLAINTEXT, KEK);
    expect(() => openPrivateJwk(sealed, undefined)).toThrow(/SIGNING_KEY_KEK/);
  });

  it("rejects a tampered ciphertext (GCM auth tag)", () => {
    // Layout: "gcm.v1:<iv>:<ct>:<tag>" -> split(":") = ["gcm.v1", iv, ct, tag].
    const parts = sealPrivateJwk(PLAINTEXT, KEK).split(":");
    const ctBuf = Buffer.from(parts[2], "base64");
    ctBuf[0] ^= 0xff; // flip a ciphertext byte
    parts[2] = ctBuf.toString("base64");
    expect(() => openPrivateJwk(parts.join(":"), KEK)).toThrow();
  });

  it("rejects a wrong-length KEK", () => {
    const shortKek = randomBytes(16).toString("base64");
    expect(() => sealPrivateJwk(PLAINTEXT, shortKek)).toThrow(/32 bytes/);
  });

  it("fails to decrypt with the wrong KEK", () => {
    const sealed = sealPrivateJwk(PLAINTEXT, KEK);
    const otherKek = Buffer.alloc(32, 9).toString("base64");
    expect(() => openPrivateJwk(sealed, otherKek)).toThrow();
  });
});
