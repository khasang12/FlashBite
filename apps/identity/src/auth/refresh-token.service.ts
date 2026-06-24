import { Injectable, Optional } from "@nestjs/common";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { PrismaService, loadConfig, type AppConfig } from "@flashbite/shared";

export type RotateResult =
  | { ok: true; raw: string; expiresAt: Date; userId: string }
  | { ok: false; reason: "reuse" | "invalid" };

@Injectable()
export class RefreshTokenService {
  private readonly cfg: AppConfig;
  constructor(private readonly prisma: PrismaService, @Optional() cfg?: AppConfig) {
    this.cfg = cfg ?? loadConfig();
  }

  private hash(raw: string): string {
    return createHash("sha256").update(raw).digest("hex");
  }
  private newRaw(): string {
    return randomBytes(32).toString("base64url");
  }
  private expiry(): Date {
    return new Date(Date.now() + this.cfg.jwtRefreshTtl * 1000);
  }

  /** Issue a brand-new refresh token (new family) for a fresh login. */
  async issue(userId: string, tenantId: string): Promise<{ raw: string; expiresAt: Date }> {
    const raw = this.newRaw();
    const expiresAt = this.expiry();
    await this.prisma.refreshToken.create({
      data: { familyId: randomUUID(), userId, tenantId, tokenHash: this.hash(raw), expiresAt },
    });
    return { raw, expiresAt };
  }

  /** One-time-use rotation. Reusing a rotated/revoked token revokes the whole family (theft response). */
  async rotate(raw: string): Promise<RotateResult> {
    await this.prune();
    const row = await this.prisma.refreshToken.findUnique({ where: { tokenHash: this.hash(raw) } });
    if (!row) return { ok: false, reason: "invalid" };
    if (row.status !== "active") {
      await this.prisma.refreshToken.updateMany({
        where: { familyId: row.familyId },
        data: { status: "revoked", revokedAt: new Date() },
      });
      return { ok: false, reason: "reuse" };
    }
    if (row.expiresAt.getTime() < Date.now()) return { ok: false, reason: "invalid" };
    const raw2 = this.newRaw();
    const expiresAt = this.expiry();
    await this.prisma.$transaction([
      this.prisma.refreshToken.update({ where: { id: row.id }, data: { status: "rotated", rotatedAt: new Date() } }),
      this.prisma.refreshToken.create({
        data: { familyId: row.familyId, userId: row.userId, tenantId: row.tenantId, tokenHash: this.hash(raw2), expiresAt },
      }),
    ]);
    return { ok: true, raw: raw2, expiresAt, userId: row.userId };
  }

  async revoke(raw: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: this.hash(raw) },
      data: { status: "revoked", revokedAt: new Date() },
    });
  }

  /** Cheap opportunistic cleanup of expired rows (no scheduler). */
  private async prune(): Promise<void> {
    await this.prisma.refreshToken.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  }
}
