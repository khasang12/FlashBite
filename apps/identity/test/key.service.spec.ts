import "reflect-metadata";
import { PrismaService } from "@flashbite/shared";
import { KeyService } from "../src/auth/key.service";

describe("KeyService (persisted, live DB)", () => {
  const prisma = new PrismaService();

  afterAll(async () => { await prisma.$disconnect(); });

  it("persists the signing key across restarts (same kid)", async () => {
    const k1 = new KeyService(prisma);
    await k1.onModuleInit();
    const kid1 = k1.signingKey().kid;
    const k2 = new KeyService(prisma);
    await k2.onModuleInit();
    expect(k2.signingKey().kid).toBe(kid1);
  });

  it("jwks() exposes the current key as a public RS256 JWK (no private fields)", async () => {
    const k = new KeyService(prisma);
    await k.onModuleInit();
    const jwk = k.jwks().keys.find((j) => j.kid === k.signingKey().kid)!;
    expect(jwk.alg).toBe("RS256");
    expect(jwk.use).toBe("sig");
    for (const f of ["d", "p", "q", "dp", "dq", "qi"]) expect((jwk as unknown as Record<string, unknown>)[f]).toBeUndefined();
  });

  it("rotate() makes a new current and keeps the old key in JWKS as previous", async () => {
    const k = new KeyService(prisma);
    await k.onModuleInit();
    const before = k.signingKey().kid;
    await k.rotate();
    const after = k.signingKey().kid;
    expect(after).not.toBe(before);
    const kids = k.jwks().keys.map((j) => j.kid);
    expect(kids).toContain(after);
    expect(kids).toContain(before);
  });
});
