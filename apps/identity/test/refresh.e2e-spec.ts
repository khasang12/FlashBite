import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import request from "supertest";
import { randomUUID } from "node:crypto";
import argon2 from "argon2";
import { importJWK, jwtVerify } from "jose";
import { AppModule } from "../src/app.module";
import { PrismaService } from "@flashbite/shared";

const RT = "fb_rt";
const cookieFrom = (res: request.Response): string => {
  const set = res.headers["set-cookie"] as unknown as string[];
  return set.map((c) => c.split(";")[0]).join("; ");
};

describe("identity refresh/logout (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const email = `cust+${randomUUID()}@berlin.test`;
  const password = "devpassword";

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);
    await prisma.user.create({ data: { tenantId: "berlin", email, passwordHash: await argon2.hash(password), role: "customer" } });
  });
  afterAll(async () => {
    const u = await prisma.user.findUnique({ where: { email } });
    if (u) await prisma.refreshToken.deleteMany({ where: { userId: u.id } });
    await prisma.user.deleteMany({ where: { email } });
    await app.close();
  });

  it("login sets an httpOnly fb_rt cookie and returns the access token", async () => {
    const res = await request(app.getHttpServer()).post("/auth/login").send({ email, password });
    expect(res.status).toBe(201);
    expect(res.body.accessToken).toBeTruthy();
    const set = (res.headers["set-cookie"] as unknown as string[]).join("\n");
    expect(set).toContain(`${RT}=`);
    expect(set).toContain("HttpOnly");
    expect(set).toContain("SameSite=Strict");
  });

  it("refresh rotates the cookie and returns a fresh, verifiable access token", async () => {
    const login = await request(app.getHttpServer()).post("/auth/login").send({ email, password });
    const cookie1 = cookieFrom(login);
    const res = await request(app.getHttpServer()).post("/auth/refresh").set("Cookie", cookie1);
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    const cookie2 = cookieFrom(res);
    expect(cookie2).not.toBe(cookie1); // rotated

    const jwks = await request(app.getHttpServer()).get("/.well-known/jwks.json");
    const pub = await importJWK(jwks.body.keys[0], "RS256");
    const { payload } = await jwtVerify(res.body.accessToken, pub, { issuer: "flashbite-identity", audience: "flashbite" });
    expect(payload.tenantId).toBe("berlin");
    expect(payload.role).toBe("customer");
  });

  it("reusing the old cookie after rotation is rejected (theft response)", async () => {
    const login = await request(app.getHttpServer()).post("/auth/login").send({ email, password });
    const cookie1 = cookieFrom(login);
    await request(app.getHttpServer()).post("/auth/refresh").set("Cookie", cookie1); // rotate once
    const reuse = await request(app.getHttpServer()).post("/auth/refresh").set("Cookie", cookie1);
    expect(reuse.status).toBe(401);
  });

  it("refresh with no cookie is 401", async () => {
    const res = await request(app.getHttpServer()).post("/auth/refresh");
    expect(res.status).toBe(401);
  });

  it("logout revokes the session so a later refresh with that cookie is 401", async () => {
    const login = await request(app.getHttpServer()).post("/auth/login").send({ email, password });
    const cookie1 = cookieFrom(login);
    const out = await request(app.getHttpServer()).post("/auth/logout").set("Cookie", cookie1);
    expect(out.status).toBe(204);
    const after = await request(app.getHttpServer()).post("/auth/refresh").set("Cookie", cookie1);
    expect(after.status).toBe(401);
  });
});
