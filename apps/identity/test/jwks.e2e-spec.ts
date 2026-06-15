import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../src/app.module";

describe("identity jwks (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    await app.init();
  });
  afterAll(async () => { await app.close(); });

  it("GET /.well-known/jwks.json -> one RS256 signing key", async () => {
    const res = await request(app.getHttpServer()).get("/.well-known/jwks.json");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.keys)).toBe(true);
    const jwk = res.body.keys[0];
    expect(jwk.kty).toBe("RSA");
    expect(jwk.alg).toBe("RS256");
    expect(jwk.use).toBe("sig");
    expect(typeof jwk.kid).toBe("string");
    expect(typeof jwk.n).toBe("string");
    expect(jwk.e).toBe("AQAB");
    for (const field of ["d", "p", "q", "dp", "dq", "qi"]) {
      expect(jwk[field as keyof typeof jwk]).toBeUndefined();
    }
  });
});
