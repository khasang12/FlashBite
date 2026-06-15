import {
  generateKeyPair,
  exportJWK,
  calculateJwkThumbprint,
  createLocalJWKSet,
  SignJWT,
  type KeyLike,
  type JWK,
} from "jose";
import { TokenVerifier } from "./token-verifier";
import type { AuthContext } from "./auth-context";

const ALG = "RS256";

export interface TestAuth {
  /** A TokenVerifier wired to a local in-memory JWKS — inject via overrideProvider. */
  verifier: TokenVerifier;
  /** Mint a valid token for the given context (1h expiry). */
  mint: (ctx: AuthContext) => Promise<string>;
  /** The private key, for hand-rolling malformed tokens in tests. */
  signWith: KeyLike;
  /** The key id used in minted token headers. */
  kid: string;
}

/**
 * Builds a self-contained auth fixture: a fresh RS256 keypair, a TokenVerifier
 * backed by a local JWKS (no network / no identity service), and a mint() helper.
 * issuer/audience default to the project defaults so minted tokens verify.
 */
export async function createTestAuth(opts?: { issuer?: string; audience?: string }): Promise<TestAuth> {
  const issuer = opts?.issuer ?? "flashbite-identity";
  const audience = opts?.audience ?? "flashbite";
  const { publicKey, privateKey } = await generateKeyPair(ALG, { extractable: true });
  const jwk = await exportJWK(publicKey);
  const kid = await calculateJwkThumbprint(jwk);
  const publicJwk: JWK = { ...jwk, kid, alg: ALG, use: "sig" };
  const keyResolver = createLocalJWKSet({ keys: [publicJwk] });
  const verifier = new TokenVerifier({ keyResolver, issuer, audience });

  const mint = (ctx: AuthContext): Promise<string> =>
    new SignJWT({ tenantId: ctx.tenantId, role: ctx.role })
      .setProtectedHeader({ alg: ALG, kid })
      .setSubject(ctx.sub)
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);

  return { verifier, mint, signWith: privateKey, kid };
}
