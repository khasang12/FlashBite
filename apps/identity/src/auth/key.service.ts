import { Injectable, OnModuleInit } from "@nestjs/common";
import { generateKeyPair, exportJWK, calculateJwkThumbprint, type KeyLike, type JWK } from "jose";

const ALG = "RS256";

@Injectable()
export class KeyService implements OnModuleInit {
  private privateKey!: KeyLike;
  private publicJwk!: JWK;

  async onModuleInit(): Promise<void> {
    // extractable:true is required by jose's exportJWK(); only the PUBLIC key is ever exported.
    const { publicKey, privateKey } = await generateKeyPair(ALG, { extractable: true });
    this.privateKey = privateKey;
    const jwk = await exportJWK(publicKey);
    const kid = await calculateJwkThumbprint(jwk);
    this.publicJwk = { ...jwk, kid, alg: ALG, use: "sig" };
  }

  /** Private key + header metadata for signing. */
  signingKey(): { key: KeyLike; kid: string; alg: string } {
    if (!this.privateKey) throw new Error("KeyService not initialized");
    return { key: this.privateKey, kid: this.publicJwk.kid as string, alg: ALG };
  }

  /** Public JWKS document. */
  jwks(): { keys: JWK[] } {
    if (!this.publicJwk) throw new Error("KeyService not initialized");
    return { keys: [this.publicJwk] };
  }
}
