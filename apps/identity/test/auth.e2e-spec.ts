import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import request from "supertest";
import { randomUUID } from "node:crypto";
import argon2 from "argon2";
import { importJWK, jwtVerify } from "jose";
import { AppModule } from "../src/app.module";
import { PrismaService } from "@flashbite/shared";

describe("identity auth (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const email = `merchant+${randomUUID()}@berlin.test`;
  const password = "devpassword";
  let userId: string;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);
    const user = await prisma.user.create({
      data: { tenantId: "berlin", email, passwordHash: await argon2.hash(password), role: "merchant" },
    });
    userId = user.id;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email } });
    await app.close();
  });

  it("logs in and returns a JWT verifiable via JWKS with the user's tenant + role", async () => {
    const res = await request(app.getHttpServer()).post("/auth/login").send({ email, password });
    expect(res.status).toBe(201);
    expect(res.body.tokenType).toBe("Bearer");
    expect(res.body.expiresIn).toBe(3600);

    const jwks = await request(app.getHttpServer()).get("/.well-known/jwks.json");
    const pub = await importJWK(jwks.body.keys[0], "RS256");
    const { payload, protectedHeader } = await jwtVerify(res.body.accessToken, pub, {
      issuer: "flashbite-identity", audience: "flashbite",
    });
    expect(protectedHeader.kid).toBe(jwks.body.keys[0].kid);
    expect(payload.sub).toBe(userId);
    expect(payload.tenantId).toBe("berlin");
    expect(payload.role).toBe("merchant");
    expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("rejects a wrong password with 401", async () => {
    const res = await request(app.getHttpServer()).post("/auth/login").send({ email, password: "wrong" });
    expect(res.status).toBe(401);
  });

  it("rejects an unknown email with 401", async () => {
    const res = await request(app.getHttpServer()).post("/auth/login").send({ email: "nobody@berlin.test", password });
    expect(res.status).toBe(401);
  });

  it("rejects a malformed body with 400", async () => {
    const res = await request(app.getHttpServer()).post("/auth/login").send({ email: "not-an-email" });
    expect(res.status).toBe(400);
  });
});
