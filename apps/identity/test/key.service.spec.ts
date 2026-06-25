import "reflect-metadata";
import { PrismaService, type AppConfig } from "@flashbite/shared";
import { KeyService } from "../src/auth/key.service";
import { isSealed, openPrivateJwk } from "../src/auth/key-cipher";

const TEST_KEK = Buffer.alloc(32, 3).toString("base64");

describe("KeyService (persisted, live DB)", () => {
  const prisma = new PrismaService();

  afterAll(async () => {
    // The encryption test re-seals this (shared dev) DB's keys under TEST_KEK. Restore them to
    // plaintext so a local `dev:identity` — which runs without a KEK — can still load them.
    for (const r of await prisma.signingKey.findMany()) {
      if (isSealed(r.privateJwk)) {
        await prisma.signingKey.update({ where: { kid: r.kid }, data: { privateJwk: openPrivateJwk(r.privateJwk, TEST_KEK) } });
      }
    }
    await prisma.$disconnect();
  });

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

  it("envelope-encrypts the private key at rest when a KEK is configured", async () => {
    const k = new KeyService(prisma, { signingKeyKek: TEST_KEK } as AppConfig);
    await k.onModuleInit();
    await k.rotate(); // force a fresh key generated under the KEK
    const kid = k.signingKey().kid;
    const row = await prisma.signingKey.findUniqueOrThrow({ where: { kid } });
    expect(isSealed(row.privateJwk)).toBe(true);
    expect(row.privateJwk).not.toContain('"d"'); // private exponent not stored in cleartext
    expect(k.signingKey().key).toBeDefined(); // and it still loads/usable for signing
  });
});
