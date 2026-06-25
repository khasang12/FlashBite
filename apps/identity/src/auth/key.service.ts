import { Injectable, Logger, Optional, OnModuleInit } from "@nestjs/common";
import {
  generateKeyPair, exportJWK, importJWK, calculateJwkThumbprint, type KeyLike, type JWK,
} from "jose";
import { loadConfig, PrismaService, type AppConfig } from "@flashbite/shared";
import { isSealed, openPrivateJwk, sealPrivateJwk } from "./key-cipher";

const ALG = "RS256";

/**
 * RSA signing key, persisted in `signing_keys` so identity restarts no longer invalidate every
 * issued token. JWKS publishes the `current` + `previous` keys so a deliberate rotation does not
 * break in-flight access tokens (their `kid` stays resolvable until the key is retired).
 *
 * The private key is envelope-encrypted at rest with a KEK (SIGNING_KEY_KEK) held outside the DB,
 * so a database-only leak cannot be used to forge tokens. The KEK is required in production; in dev
 * it may be omitted, in which case the key is stored plaintext with a loud warning.
 */
@Injectable()
export class KeyService implements OnModuleInit {
  private readonly logger = new Logger(KeyService.name);
  private currentKid!: string;
  private currentKey!: KeyLike;
  private publicJwks: JWK[] = [];

  private readonly kek: string | undefined;
  constructor(private readonly prisma: PrismaService, @Optional() cfg?: AppConfig) {
    this.kek = (cfg ?? loadConfig()).signingKeyKek;
  }

  async onModuleInit(): Promise<void> {
    await this.load();
  }

  private async load(): Promise<void> {
    if (!this.kek) {
      if (process.env.NODE_ENV === "production") {
        throw new Error("SIGNING_KEY_KEK is required in production to encrypt the signing key at rest");
      }
      this.logger.warn("SIGNING_KEY_KEK not set — signing key stored UNENCRYPTED at rest (dev only).");
    }
    const found = await this.prisma.signingKey.findFirst({ where: { status: "current" } });
    const current = found ?? (await this.generate());
    const rows = await this.prisma.signingKey.findMany({ where: { status: { in: ["current", "previous"] } }, orderBy: { createdAt: "desc" } });
    this.currentKid = current.kid;
    this.currentKey = (await importJWK(JSON.parse(openPrivateJwk(current.privateJwk, this.kek)) as JWK, ALG)) as KeyLike;
    this.publicJwks = rows.map((r) => ({ ...(JSON.parse(r.publicJwk) as JWK), kid: r.kid, alg: ALG, use: "sig" }));
    await this.migrateLegacyPlaintext(rows);
  }

  /** One-time upgrade: re-seal any legacy plaintext rows once a KEK is configured. */
  private async migrateLegacyPlaintext(rows: { kid: string; privateJwk: string }[]): Promise<void> {
    if (!this.kek) return;
    for (const r of rows) {
      if (isSealed(r.privateJwk)) continue;
      await this.prisma.signingKey.update({ where: { kid: r.kid }, data: { privateJwk: sealPrivateJwk(r.privateJwk, this.kek) } });
      this.logger.log(`Re-sealed legacy plaintext signing key ${r.kid} under SIGNING_KEY_KEK.`);
    }
  }

  private async generate() {
    // extractable:true so exportJWK() can serialize BOTH keys for persistence.
    const { publicKey, privateKey } = await generateKeyPair(ALG, { extractable: true });
    const pubJwk = await exportJWK(publicKey);
    const privJwk = JSON.stringify(await exportJWK(privateKey));
    const kid = await calculateJwkThumbprint(pubJwk);
    return this.prisma.signingKey.create({
      data: {
        kid,
        alg: ALG,
        publicJwk: JSON.stringify(pubJwk),
        privateJwk: this.kek ? sealPrivateJwk(privJwk, this.kek) : privJwk,
        status: "current",
      },
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
