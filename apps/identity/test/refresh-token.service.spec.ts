import "reflect-metadata";
import { PrismaService, loadConfig } from "@flashbite/shared";
import { createHash } from "node:crypto";
import { RefreshTokenService } from "../src/auth/refresh-token.service";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("RefreshTokenService (live DB)", () => {
  const prisma = new PrismaService();
  const svc = new RefreshTokenService(prisma);
  const userId = `u-${Date.now()}`;
  const tenantId = "berlin";

  afterAll(async () => {
    await prisma.refreshToken.deleteMany({ where: { userId } });
    await prisma.$disconnect();
  });

  it("issue() stores a hashed active row and returns the raw token", async () => {
    const { raw } = await svc.issue(userId, tenantId);
    const row = await prisma.refreshToken.findUnique({ where: { tokenHash: sha(raw) } });
    expect(row?.status).toBe("active");
    expect(row?.userId).toBe(userId);
    // raw is never stored verbatim
    const verbatim = await prisma.refreshToken.findFirst({ where: { tokenHash: raw } });
    expect(verbatim).toBeNull();
  });

  it("rotate() marks the old row rotated and issues a successor in the same family", async () => {
    const { raw } = await svc.issue(userId, tenantId);
    const oldHash = sha(raw);
    const res = await svc.rotate(raw);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.userId).toBe(userId);
    const oldRow = await prisma.refreshToken.findUnique({ where: { tokenHash: oldHash } });
    const newRow = await prisma.refreshToken.findUnique({ where: { tokenHash: sha(res.raw) } });
    expect(oldRow?.status).toBe("rotated");
    expect(newRow?.status).toBe("active");
    expect(newRow?.familyId).toBe(oldRow?.familyId);
  });

  it("reuse of a rotated token beyond the grace window revokes the whole family", async () => {
    const strict = new RefreshTokenService(prisma, { ...loadConfig(), refreshReuseGraceMs: 0 });
    const { raw } = await strict.issue(userId, tenantId);
    const first = await strict.rotate(raw);
    expect(first.ok).toBe(true);
    const reuse = await strict.rotate(raw); // already rotated; grace 0 => treated as theft
    expect(reuse).toEqual({ ok: false, reason: "reuse" });
    const familyId = (await prisma.refreshToken.findUnique({ where: { tokenHash: sha(raw) } }))!.familyId;
    const rows = await prisma.refreshToken.findMany({ where: { familyId } });
    expect(rows.every((r) => r.status === "revoked")).toBe(true);
  });

  it("reuse within the grace window returns a fresh successor instead of revoking (benign reload race)", async () => {
    // Default svc has a non-zero grace window; re-presenting the just-rotated token is treated as a race.
    const { raw } = await svc.issue(userId, tenantId);
    const first = await svc.rotate(raw);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const graced = await svc.rotate(raw); // already rotated, but within grace
    expect(graced.ok).toBe(true);
    if (!graced.ok) return;
    expect(graced.raw).not.toBe(first.raw); // a fresh successor token
    expect(graced.userId).toBe(userId);
    const familyId = (await prisma.refreshToken.findUnique({ where: { tokenHash: sha(raw) } }))!.familyId;
    const rows = await prisma.refreshToken.findMany({ where: { familyId } });
    expect(rows.some((r) => r.status === "active")).toBe(true); // family still usable
    expect(rows.every((r) => r.status === "revoked")).toBe(false); // not revoked
  });

  it("rotate() of an unknown token is invalid", async () => {
    expect(await svc.rotate("nope")).toEqual({ ok: false, reason: "invalid" });
  });

  it("revoke() marks the row revoked", async () => {
    const { raw } = await svc.issue(userId, tenantId);
    await svc.revoke(raw);
    const row = await prisma.refreshToken.findUnique({ where: { tokenHash: sha(raw) } });
    expect(row?.status).toBe("revoked");
  });
});
