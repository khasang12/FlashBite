import { Injectable, Optional } from "@nestjs/common";
import { jwtVerify, createRemoteJWKSet, type JWTVerifyGetKey } from "jose";
import { loadConfig } from "@flashbite/shared";
import type { AuthContext } from "./auth-context";

export interface TokenVerifierOptions {
  keyResolver?: JWTVerifyGetKey;
  issuer?: string;
  audience?: string;
}

/**
 * Verifies RS256 JWTs against the identity JWKS and maps claims to an AuthContext.
 * Default ctor builds a remote JWKS resolver from config; tests inject a local one.
 */
@Injectable()
export class TokenVerifier {
  private readonly keyResolver: JWTVerifyGetKey;
  private readonly issuer: string;
  private readonly audience: string;

  constructor(@Optional() opts?: TokenVerifierOptions) {
    const cfg = loadConfig();
    this.issuer = opts?.issuer ?? cfg.jwtIssuer;
    this.audience = opts?.audience ?? cfg.jwtAudience;
    this.keyResolver = opts?.keyResolver ?? createRemoteJWKSet(new URL(cfg.jwtJwksUrl));
  }

  async verify(token: string): Promise<AuthContext> {
    const { payload } = await jwtVerify(token, this.keyResolver, {
      issuer: this.issuer,
      audience: this.audience,
      algorithms: ["RS256"],
    });
    const tenantId = payload.tenantId;
    const role = payload.role;
    const sub = payload.sub;
    if (typeof tenantId !== "string" || typeof role !== "string" || typeof sub !== "string") {
      throw new Error("token missing required claims");
    }
    return { tenantId, role, sub };
  }
}
