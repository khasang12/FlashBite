import { Injectable, OnModuleInit } from "@nestjs/common";
import {
  generateKeyPair, exportJWK, importJWK, calculateJwkThumbprint, type KeyLike, type JWK,
} from "jose";
import { PrismaService } from "@flashbite/shared";

const ALG = "RS256";

/**
 * RSA signing key, persisted in `signing_keys` so identity restarts no longer invalidate every
 * issued token. JWKS publishes the `current` + `previous` keys so a deliberate rotation does not
 * break in-flight access tokens (their `kid` stays resolvable until the key is retired).
 */
@Injectable()
export class KeyService implements OnModuleInit {
  private currentKid!: string;
  private currentKey!: KeyLike;
  private publicJwks: JWK[] = [];

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.load();
  }

  private async load(): Promise<void> {
    const found = await this.prisma.signingKey.findFirst({ where: { status: "current" } });
    const current = found ?? (await this.generate());
    const rows = await this.prisma.signingKey.findMany({ where: { status: { in: ["current", "previous"] } }, orderBy: { createdAt: "desc" } });
    this.currentKid = current.kid;
    this.currentKey = (await importJWK(JSON.parse(current.privateJwk) as JWK, ALG)) as KeyLike;
    this.publicJwks = rows.map((r) => ({ ...(JSON.parse(r.publicJwk) as JWK), kid: r.kid, alg: ALG, use: "sig" }));
  }

  private async generate() {
    // extractable:true so exportJWK() can serialize BOTH keys for persistence.
    const { publicKey, privateKey } = await generateKeyPair(ALG, { extractable: true });
    const pubJwk = await exportJWK(publicKey);
    const privJwk = await exportJWK(privateKey);
    const kid = await calculateJwkThumbprint(pubJwk);
    return this.prisma.signingKey.create({
      data: { kid, alg: ALG, publicJwk: JSON.stringify(pubJwk), privateJwk: JSON.stringify(privJwk), status: "current" },
    });
  }

  /** Private key + header metadata for signing the access token. */
  signingKey(): { key: KeyLike; kid: string; alg: string } {
    if (!this.currentKey) throw new Error("KeyService not initialized");
    return { key: this.currentKey, kid: this.currentKid, alg: ALG };
  }

  /** Public JWKS document (current + previous keys). */
  jwks(): { keys: JWK[] } {
    return { keys: this.publicJwks };
  }

  /** Deliberate rotation: new current, old current -> previous, old previous -> retired. */
  async rotate(): Promise<void> {
    await this.prisma.signingKey.updateMany({ where: { status: "previous" }, data: { status: "retired" } });
    await this.prisma.signingKey.updateMany({ where: { status: "current" }, data: { status: "previous" } });
    await this.generate();
    await this.load();
  }
}
