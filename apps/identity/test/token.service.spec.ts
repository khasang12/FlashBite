import "reflect-metadata";
import { importJWK, jwtVerify } from "jose";
import { PrismaService } from "@flashbite/shared";
import { KeyService } from "../src/auth/key.service";
import { TokenService } from "../src/auth/token.service";

describe("TokenService", () => {
  const prisma = new PrismaService();

  afterAll(async () => { await prisma.$disconnect(); });

  it("signs an RS256 token with the documented claims, verifiable via the public JWK", async () => {
    const keys = new KeyService(prisma);
    await keys.onModuleInit();
    const cfg = { jwtIssuer: "flashbite-identity", jwtAudience: "flashbite", jwtAccessTtl: 3600 };
    const tokens = new TokenService(keys, cfg as never);

    const jwt = await tokens.sign({ sub: "u-1", tenantId: "berlin", role: "merchant" });
    const jwk = keys.jwks().keys[0];
    const pub = await importJWK(jwk, "RS256");
    const { payload, protectedHeader } = await jwtVerify(jwt, pub, {
      issuer: "flashbite-identity", audience: "flashbite",
    });

    expect(protectedHeader.alg).toBe("RS256");
    expect(protectedHeader.kid).toBe(jwk.kid);
    expect(payload.sub).toBe("u-1");
    expect(payload.tenantId).toBe("berlin");
    expect(payload.role).toBe("merchant");
    expect(payload.exp! - payload.iat!).toBe(3600);
  });
});
