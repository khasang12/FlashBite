# Phase 2a Identity Service + JWT Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new `apps/identity` NestJS service that authenticates seeded users (argon2id) and issues RS256-signed access tokens, publishing its public keys at a JWKS endpoint.

**Architecture:** Stateless NestJS service on :3003 reusing the shared Prisma client (new `User` model in the existing Postgres). Generates an RS256 keypair in memory at boot (via `jose`), signs login tokens with a `kid`-tagged key, and serves the public key at `/.well-known/jwks.json`. No other service consumes the tokens yet (that is slice 2b).

**Tech Stack:** NestJS 10, Prisma 5 (Postgres), `jose` (RS256 + JWKS), `argon2` (argon2id), Jest + supertest.

**Spec:** `docs/superpowers/specs/2026-06-15-flashbite-phase-2a-identity-jwt-design.md`

**Infra note:** every task that runs migrations or e2e needs `pnpm infra:up` (Postgres) and a `.env` with `DATABASE_URL`. Run all commands from the repo root; do not use a bare `cd` (a zoxide shell hook breaks it) — use `pnpm --filter` / absolute paths.

---

## File Structure

- `packages/shared/prisma/schema.prisma` — add `User` model (+ generated migration).
- `packages/shared/src/config.ts` — add `jwtIssuer` / `jwtAudience` / `jwtAccessTtl` to `AppConfig` + `loadConfig`.
- `packages/shared/src/config.spec.ts` — new config test.
- `apps/identity/` — new service:
  - `package.json`, `tsconfig.json`, `tsconfig.build.json`, `nest-cli.json`
  - `src/main.ts` (bootstrap :3003), `src/app.module.ts`, `src/health.controller.ts`
  - `src/auth/key.service.ts` (RS256 keypair + JWKS), `src/auth/jwks.controller.ts`
  - `src/auth/token.service.ts` (sign access token), `src/auth/auth.service.ts` (argon2 verify),
    `src/auth/login.dto.ts`, `src/auth/auth.controller.ts`, `src/auth/auth.module.ts`
  - `src/seed.ts` (dev seed of demo users)
  - `test/health.e2e-spec.ts`, `test/jwks.e2e-spec.ts`, `test/auth.e2e-spec.ts`, `test/token.service.spec.ts`
- root `package.json` — add `dev:identity` + `seed:users` scripts.
- `.env.example` — add the new vars.

---

## Task 1: Prisma `User` model + migration

**Files:**
- Modify: `packages/shared/prisma/schema.prisma`
- Create: a Prisma migration under `packages/shared/prisma/migrations/`

- [ ] **Step 1: Add the model**

Append to `packages/shared/prisma/schema.prisma`:
```prisma
model User {
  id           String   @id @default(uuid()) @db.Uuid
  tenantId     String   @map("tenant_id")
  email        String   @unique
  passwordHash String   @map("password_hash")
  role         String
  createdAt    DateTime @default(now()) @map("created_at")

  @@index([tenantId])
  @@map("users")
}
```
(Note: `email` is **globally unique** — login resolves the user, and therefore the tenant, by email alone; this is the deliberate inversion of Phase 1's request-supplied tenant. The seed uses `role@tenant.test` so emails are distinct anyway.)

- [ ] **Step 2: Generate the migration (needs Postgres up)**

Run: `pnpm infra:up` then
`pnpm --filter @flashbite/shared exec prisma migrate dev --name add_users --schema prisma/schema.prisma`
Expected: creates `packages/shared/prisma/migrations/<timestamp>_add_users/migration.sql` and applies it.

- [ ] **Step 3: Verify the migration + client**

Run: `grep -i "create table" packages/shared/prisma/migrations/*_add_users/migration.sql`
Expected: a `CREATE TABLE "users"` statement.
Run: `pnpm --filter @flashbite/shared prisma:generate`
Expected: client regenerated (now exposes `prisma.user`).

- [ ] **Step 4: Commit**

```bash
git add packages/shared/prisma/schema.prisma packages/shared/prisma/migrations
git commit -m "feat(shared): add User model + migration for identity"
```

---

## Task 2: Shared config — JWT settings

**Files:**
- Modify: `packages/shared/src/config.ts`
- Test: `packages/shared/src/config.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/config.spec.ts`:
```ts
import { loadConfig } from "./config";

describe("loadConfig JWT settings", () => {
  const base = { DATABASE_URL: "postgres://x" };

  it("defaults issuer/audience/ttl", () => {
    const c = loadConfig({ ...base });
    expect(c.jwtIssuer).toBe("flashbite-identity");
    expect(c.jwtAudience).toBe("flashbite");
    expect(c.jwtAccessTtl).toBe(3600);
  });

  it("reads overrides from env", () => {
    const c = loadConfig({ ...base, JWT_ISSUER: "iss", JWT_AUDIENCE: "aud", JWT_ACCESS_TTL: "900" });
    expect(c.jwtIssuer).toBe("iss");
    expect(c.jwtAudience).toBe("aud");
    expect(c.jwtAccessTtl).toBe(900);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec jest packages/shared/src/config.spec.ts`
Expected: FAIL — `jwtIssuer` etc. are `undefined` on `AppConfig`.

- [ ] **Step 3: Add the fields**

In `packages/shared/src/config.ts`, add to the `AppConfig` interface (after `sagaSlaSeconds: number;`):
```ts
  jwtIssuer: string;
  jwtAudience: string;
  jwtAccessTtl: number;
```
And in the object returned by `loadConfig` (after `sagaSlaSeconds: ...,`):
```ts
    jwtIssuer: env.JWT_ISSUER ?? "flashbite-identity",
    jwtAudience: env.JWT_AUDIENCE ?? "flashbite",
    jwtAccessTtl: Number(env.JWT_ACCESS_TTL ?? 3600),
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm exec jest packages/shared/src/config.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/config.ts packages/shared/src/config.spec.ts
git commit -m "feat(shared): JWT issuer/audience/ttl config"
```

---

## Task 3: Scaffold `apps/identity` (:3003) + deps + health

**Files:** new `apps/identity/*` (config + bootstrap + health); modify root `package.json`; `.env.example`.

- [ ] **Step 1: Create `apps/identity/package.json`**

```json
{
  "name": "@flashbite/identity",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "start": "node -r @swc-node/register -r tsconfig-paths/register src/main.ts"
  },
  "dependencies": {
    "@flashbite/shared": "workspace:*",
    "@nestjs/common": "10.4.4",
    "@nestjs/core": "10.4.4",
    "@nestjs/platform-express": "10.4.4",
    "@prisma/client": "5.18.0",
    "argon2": "^0.41.1",
    "class-transformer": "0.5.1",
    "class-validator": "0.14.1",
    "jose": "^5.9.6",
    "reflect-metadata": "0.2.2",
    "rxjs": "7.8.1"
  },
  "devDependencies": {
    "@nestjs/cli": "10.4.4",
    "@nestjs/schematics": "10.1.4",
    "@nestjs/testing": "10.4.4",
    "@types/supertest": "6.0.2",
    "supertest": "7.0.0"
  }
}
```

- [ ] **Step 2: Copy the build config from write-api (verbatim)**

- `apps/identity/tsconfig.json` — copy `apps/write-api/tsconfig.json` verbatim.
- `apps/identity/tsconfig.build.json` — copy `apps/write-api/tsconfig.build.json` verbatim.
- `apps/identity/nest-cli.json` — copy `apps/write-api/nest-cli.json` verbatim.

- [ ] **Step 3: Bootstrap + health + module**

`apps/identity/src/main.ts`:
```ts
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { AppModule } from "./app.module";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  const port = Number(process.env.IDENTITY_PORT ?? 3003);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`identity listening on ${port}`);
}

bootstrap();
```

`apps/identity/src/health.controller.ts` (no tenant context — identity is unauthenticated, so it must NOT call `getTenantId()`):
```ts
import { Controller, Get } from "@nestjs/common";

@Controller("health")
export class HealthController {
  @Get()
  check(): { status: string } {
    return { status: "ok" };
  }
}
```

`apps/identity/src/app.module.ts` (AuthModule is added in Task 4/5; for now just Health):
```ts
import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller";
import { AuthModule } from "./auth/auth.module";

@Module({
  imports: [AuthModule],
  controllers: [HealthController],
})
export class AppModule {}
```
Because `AuthModule` does not exist until Task 4, **for this task only** temporarily omit the `AuthModule` import and the `imports` array (leave `controllers: [HealthController]`), then restore it in Task 4. (Write it now as `@Module({ controllers: [HealthController] })` with no imports.)

- [ ] **Step 4: Add root scripts**

In root `package.json`, after `"dev:telemetry": ...` add:
```json
    "dev:identity": "node -r @swc-node/register -r tsconfig-paths/register --env-file=.env apps/identity/src/main.ts",
```
After the last `dev:web-admin` line, also add (used in Task 6):
```json
    "seed:users": "node -r @swc-node/register -r tsconfig-paths/register --env-file=.env apps/identity/src/seed.ts",
```

- [ ] **Step 5: `.env.example` additions**

Append to `.env.example`:
```
# Identity (Phase 2a)
IDENTITY_PORT=3003
JWT_ISSUER=flashbite-identity
JWT_AUDIENCE=flashbite
JWT_ACCESS_TTL=3600
SEED_USER_PASSWORD=devpassword
```

- [ ] **Step 6: Install + health e2e**

Run: `pnpm install`
Expected: installs `jose`, `argon2`, nest deps for the new workspace.

Create `apps/identity/test/health.e2e-spec.ts`:
```ts
import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../src/app.module";

describe("identity health (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    await app.init();
  });
  afterAll(async () => { await app.close(); });

  it("GET /health -> ok", async () => {
    const res = await request(app.getHttpServer()).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});
```

Run: `pnpm exec jest apps/identity/test/health.e2e-spec.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/identity package.json pnpm-lock.yaml .env.example
git commit -m "feat(identity): scaffold NestJS service on :3003 + health"
```

---

## Task 4: KeyService (RS256 keypair) + JWKS endpoint

**Files:**
- Create: `apps/identity/src/auth/key.service.ts`, `apps/identity/src/auth/jwks.controller.ts`, `apps/identity/src/auth/auth.module.ts`
- Modify: `apps/identity/src/app.module.ts` (add `AuthModule`)
- Test: `apps/identity/test/jwks.e2e-spec.ts`

- [ ] **Step 1: Write the failing e2e**

Create `apps/identity/test/jwks.e2e-spec.ts`:
```ts
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
    expect(jwk.d).toBeUndefined(); // public only — no private material
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec jest apps/identity/test/jwks.e2e-spec.ts`
Expected: FAIL — route `/.well-known/jwks.json` 404 (KeyService/controller not built).

- [ ] **Step 3: KeyService**

`apps/identity/src/auth/key.service.ts`:
```ts
import { Injectable, OnModuleInit } from "@nestjs/common";
import { generateKeyPair, exportJWK, calculateJwkThumbprint, type KeyLike, type JWK } from "jose";

const ALG = "RS256";

@Injectable()
export class KeyService implements OnModuleInit {
  private privateKey!: KeyLike;
  private publicJwk!: JWK;

  async onModuleInit(): Promise<void> {
    const { publicKey, privateKey } = await generateKeyPair(ALG, { extractable: true });
    this.privateKey = privateKey;
    const jwk = await exportJWK(publicKey);
    const kid = await calculateJwkThumbprint(jwk);
    this.publicJwk = { ...jwk, kid, alg: ALG, use: "sig" };
  }

  /** Private key + header metadata for signing. */
  signingKey(): { key: KeyLike; kid: string; alg: string } {
    return { key: this.privateKey, kid: this.publicJwk.kid as string, alg: ALG };
  }

  /** Public JWKS document. */
  jwks(): { keys: JWK[] } {
    return { keys: [this.publicJwk] };
  }
}
```

- [ ] **Step 4: JWKS controller**

`apps/identity/src/auth/jwks.controller.ts`:
```ts
import { Controller, Get } from "@nestjs/common";
import type { JWK } from "jose";
import { KeyService } from "./key.service";

@Controller(".well-known")
export class JwksController {
  constructor(private readonly keys: KeyService) {}

  @Get("jwks.json")
  jwks(): { keys: JWK[] } {
    return this.keys.jwks();
  }
}
```

- [ ] **Step 5: AuthModule + wire into AppModule**

`apps/identity/src/auth/auth.module.ts`:
```ts
import { Module } from "@nestjs/common";
import { KeyService } from "./key.service";
import { JwksController } from "./jwks.controller";

@Module({
  controllers: [JwksController],
  providers: [KeyService],
  exports: [KeyService],
})
export class AuthModule {}
```
In `apps/identity/src/app.module.ts`, restore the `AuthModule` import + `imports: [AuthModule]` (as shown in Task 3 Step 3's final form).

- [ ] **Step 6: Run to verify it passes**

Run: `pnpm exec jest apps/identity/test/jwks.e2e-spec.ts apps/identity/test/health.e2e-spec.ts`
Expected: PASS.
> If jose fails under ts-jest with "Cannot use import statement outside a module", it resolved the ESM build. Fix by ensuring node resolution picks jose's CJS export (jose ^5 ships a `require` condition); if needed add `"jose"` to a `transformIgnorePatterns` exception in the root `jest.config.cjs`. Report if you hit this.

- [ ] **Step 7: Commit**

```bash
git add apps/identity/src/auth/key.service.ts apps/identity/src/auth/jwks.controller.ts apps/identity/src/auth/auth.module.ts apps/identity/src/app.module.ts apps/identity/test/jwks.e2e-spec.ts
git commit -m "feat(identity): RS256 keypair + JWKS endpoint"
```

---

## Task 5: Login — TokenService + AuthService + `POST /auth/login`

**Files:**
- Create: `apps/identity/src/auth/token.service.ts`, `apps/identity/src/auth/auth.service.ts`, `apps/identity/src/auth/login.dto.ts`, `apps/identity/src/auth/auth.controller.ts`
- Modify: `apps/identity/src/auth/auth.module.ts`
- Test: `apps/identity/test/token.service.spec.ts`, `apps/identity/test/auth.e2e-spec.ts`

- [ ] **Step 1: TokenService unit test**

Create `apps/identity/test/token.service.spec.ts`:
```ts
import { importJWK, jwtVerify } from "jose";
import { KeyService } from "../src/auth/key.service";
import { TokenService } from "../src/auth/token.service";

describe("TokenService", () => {
  it("signs an RS256 token with the documented claims, verifiable via the public JWK", async () => {
    const keys = new KeyService();
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec jest apps/identity/test/token.service.spec.ts`
Expected: FAIL — cannot find `../src/auth/token.service`.

- [ ] **Step 3: TokenService**

`apps/identity/src/auth/token.service.ts`:
```ts
import { Injectable } from "@nestjs/common";
import { SignJWT } from "jose";
import { loadConfig, type AppConfig } from "@flashbite/shared";
import { KeyService } from "./key.service";

export interface AccessClaims {
  sub: string;
  tenantId: string;
  role: string;
}

@Injectable()
export class TokenService {
  private readonly cfg: AppConfig;
  constructor(private readonly keys: KeyService, cfg?: AppConfig) {
    this.cfg = cfg ?? loadConfig();
  }

  async sign(claims: AccessClaims): Promise<string> {
    const { key, kid, alg } = this.keys.signingKey();
    return new SignJWT({ tenantId: claims.tenantId, role: claims.role })
      .setProtectedHeader({ alg, kid })
      .setSubject(claims.sub)
      .setIssuer(this.cfg.jwtIssuer)
      .setAudience(this.cfg.jwtAudience)
      .setIssuedAt()
      .setExpirationTime(`${this.cfg.jwtAccessTtl}s`)
      .sign(key);
  }
}
```
(The optional `cfg` arg lets the unit test inject config; in the app, Nest constructs it with just `KeyService` and it falls back to `loadConfig()`.)

- [ ] **Step 4: Run TokenService test to verify it passes**

Run: `pnpm exec jest apps/identity/test/token.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: LoginDto + AuthService + AuthController**

`apps/identity/src/auth/login.dto.ts`:
```ts
import { IsEmail, IsString, MinLength } from "class-validator";

export class LoginDto {
  @IsEmail() email!: string;
  @IsString() @MinLength(1) password!: string;
}
```

`apps/identity/src/auth/auth.service.ts`:
```ts
import { Injectable, UnauthorizedException } from "@nestjs/common";
import argon2 from "argon2";
import { PrismaService, loadConfig } from "@flashbite/shared";
import { TokenService } from "./token.service";

export interface LoginResult {
  accessToken: string;
  tokenType: "Bearer";
  expiresIn: number;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
  ) {}

  async login(email: string, password: string): Promise<LoginResult> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    // Verify even when the user is missing, to avoid timing-based user enumeration.
    const hash = user?.passwordHash ?? "$argon2id$v=19$m=65536,t=3,p=4$0000000000000000$0000000000000000000000000000000000000000000";
    let ok = false;
    try {
      ok = await argon2.verify(hash, password);
    } catch {
      ok = false;
    }
    if (!user || !ok) {
      throw new UnauthorizedException("Invalid email or password");
    }
    const accessToken = await this.tokens.sign({ sub: user.id, tenantId: user.tenantId, role: user.role });
    return { accessToken, tokenType: "Bearer", expiresIn: loadConfig().jwtAccessTtl };
  }
}
```

`apps/identity/src/auth/auth.controller.ts`:
```ts
import { Body, Controller, Post } from "@nestjs/common";
import { AuthService, type LoginResult } from "./auth.service";
import { LoginDto } from "./login.dto";

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post("login")
  login(@Body() dto: LoginDto): Promise<LoginResult> {
    return this.auth.login(dto.email, dto.password);
  }
}
```

- [ ] **Step 6: Wire providers into AuthModule**

Replace `apps/identity/src/auth/auth.module.ts` with:
```ts
import { Module } from "@nestjs/common";
import { PrismaService } from "@flashbite/shared";
import { KeyService } from "./key.service";
import { JwksController } from "./jwks.controller";
import { TokenService } from "./token.service";
import { AuthService } from "./auth.service";
import { AuthController } from "./auth.controller";

@Module({
  controllers: [JwksController, AuthController],
  providers: [KeyService, TokenService, AuthService, PrismaService],
  exports: [KeyService],
})
export class AuthModule {}
```

- [ ] **Step 7: Login e2e**

Create `apps/identity/test/auth.e2e-spec.ts`:
```ts
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
```

- [ ] **Step 8: Run to verify it passes (infra up)**

Run: `pnpm exec jest apps/identity/test/auth.e2e-spec.ts apps/identity/test/token.service.spec.ts`
Expected: PASS (login 201 + verifiable token; 401 x2; 400). Needs `pnpm infra:up` + the `add_users` migration applied (Task 1).

- [ ] **Step 9: Commit**

```bash
git add apps/identity/src/auth/token.service.ts apps/identity/src/auth/auth.service.ts apps/identity/src/auth/login.dto.ts apps/identity/src/auth/auth.controller.ts apps/identity/src/auth/auth.module.ts apps/identity/test/token.service.spec.ts apps/identity/test/auth.e2e-spec.ts
git commit -m "feat(identity): argon2 login -> RS256 access token (POST /auth/login)"
```

---

## Task 6: Dev seed of demo users

**Files:**
- Create: `apps/identity/src/seed.ts`
- (root `seed:users` script was added in Task 3 Step 4)

- [ ] **Step 1: Write the seed**

`apps/identity/src/seed.ts`:
```ts
import argon2 from "argon2";
import { PrismaClient } from "@flashbite/shared";

const TENANTS = ["berlin", "tokyo"] as const;
const ROLES = ["customer", "merchant", "driver", "admin"] as const;

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const password = process.env.SEED_USER_PASSWORD ?? "devpassword";
  const passwordHash = await argon2.hash(password);
  try {
    for (const tenantId of TENANTS) {
      for (const role of ROLES) {
        const email = `${role}@${tenantId}.test`;
        await prisma.user.upsert({
          where: { email },
          update: { tenantId, role, passwordHash },
          create: { tenantId, role, email, passwordHash },
        });
        // eslint-disable-next-line no-console
        console.log(`seeded ${email} (${tenantId}/${role})`);
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Run the seed (infra up)**

Run: `pnpm seed:users`
Expected: prints 8 `seeded ...` lines (2 tenants × 4 roles); re-running is idempotent (upsert).

- [ ] **Step 3: Verify a seeded user can log in**

Run: `pnpm exec jest apps/identity/test/auth.e2e-spec.ts`
Expected: still PASS (unaffected; uses its own user). The seed is for dev/demo + slices 2b–2d.

- [ ] **Step 4: Commit**

```bash
git add apps/identity/src/seed.ts
git commit -m "feat(identity): dev seed for per-tenant demo users"
```

---

## Final Verification

- [ ] `pnpm exec jest apps/identity packages/shared/src/config.spec.ts` — identity e2e + config tests pass (infra up).
- [ ] `pnpm test` — full backend suite green (new identity tests included; web apps ignored).
- [ ] `pnpm dev:identity` then a manual login (optional): `POST http://localhost:3003/auth/login` with a seeded user returns a Bearer token; `GET http://localhost:3003/.well-known/jwks.json` returns the public key.
- [ ] Confirm **no private key material** is ever returned by JWKS (`d`, `p`, `q` absent) and the keypair is in-memory only (no key files written, nothing committed).
