# Identity hardening — access + refresh tokens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace identity's single long-lived JWT with a short-lived access token (AT) plus a server-tracked, rotating refresh token (RT) delivered as an httpOnly cookie, and persist the signing key with current+previous JWKS rotation.

**Architecture:** identity gains two Prisma tables (`refresh_tokens`, `signing_keys`); `KeyService` persists/rotates the RSA key; a new `RefreshTokenService` issues/rotates/reuse-detects/revokes RTs; `AuthController` sets/reads the RT cookie on `login`/`refresh`/`logout`. The AT stays an RS256 JWT verified unchanged at resource servers. web-shared's `authedFetch` transparently refreshes on 401 (single-flight) and retries.

**Tech Stack:** NestJS 10.4.4 + jose 5.9.6 (identity, Jest/ts-jest + supertest, live Postgres), Prisma 5.18, Next.js 16 + zustand (web-shared, Vitest).

**Branch:** `phase-identity-at-rt-hardening` (already created off `main`).

## Global Constraints

- Signing alg is **RS256** (unchanged). AT claim shape is unchanged: `{ sub, tenantId, role, iss, aud, iat, exp }`.
- Login JSON body shape is **unchanged**: `{ accessToken, tokenType: "Bearer", expiresIn }` (so `stream-gps.sh` / `requests.http` keep working).
- `JWT_ACCESS_TTL` default **900** (15 min). `JWT_REFRESH_TTL` default **2592000** (30 d).
- RT is an opaque 256-bit random token; **only its sha-256 hash is stored — never the raw value**.
- RT cookie: `HttpOnly; SameSite=Strict; Secure` (Secure only when `RT_COOKIE_SECURE=true`); `Path` = `RT_COOKIE_PATH` default **`/api/identity/auth`** (the browser-facing proxied path, NOT `/auth`).
- RT rotation is one-time-use; presenting a rotated/revoked RT revokes the whole `familyId`.
- jose APIs: `generateKeyPair("RS256", { extractable: true })`, `exportJWK`, `importJWK(jwk, "RS256")`, `calculateJwkThumbprint`. Node crypto: `randomBytes`, `createHash`, `randomUUID` from `node:crypto`.
- Identity is on `@nestjs/platform-express`; controllers use `@Res({ passthrough: true })` to set cookies and `@Req()` to read them, typed with minimal structural types (no `@types/express` dependency).

---

## Task 1: Prisma models + migration + config fields

**Files:**
- Modify: `packages/shared/prisma/schema.prisma`
- Create: `packages/shared/prisma/migrations/20260622000000_refresh_tokens_signing_keys/migration.sql`
- Modify: `packages/shared/src/config.ts`
- Modify: `apps/identity/test/auth.e2e-spec.ts:39` (the `expiresIn` assertion)
- Test: `packages/shared/test/config.spec.ts`

**Interfaces:**
- Produces: `AppConfig` gains `jwtRefreshTtl: number; rtCookieName: string; rtCookieSecure: boolean; rtCookiePath: string;` and `jwtAccessTtl` now defaults to 900. Prisma models `RefreshToken` and `SigningKey` (see schema below) become available as `prisma.refreshToken` / `prisma.signingKey`.

- [ ] **Step 1: Write the failing config test** — create `packages/shared/test/config.spec.ts`:
```ts
import { loadConfig } from "../src/config";

describe("loadConfig auth/token + cookie defaults", () => {
  const base = { DATABASE_URL: "postgresql://u:p@localhost:5432/db" };

  it("defaults the access TTL to 900 and refresh TTL to 2592000", () => {
    const cfg = loadConfig(base);
    expect(cfg.jwtAccessTtl).toBe(900);
    expect(cfg.jwtRefreshTtl).toBe(2592000);
  });

  it("defaults the RT cookie name/path and secure=false (dev)", () => {
    const cfg = loadConfig(base);
    expect(cfg.rtCookieName).toBe("fb_rt");
    expect(cfg.rtCookiePath).toBe("/api/identity/auth");
    expect(cfg.rtCookieSecure).toBe(false);
  });

  it("honors env overrides", () => {
    const cfg = loadConfig({ ...base, JWT_ACCESS_TTL: "60", JWT_REFRESH_TTL: "120", RT_COOKIE_SECURE: "true", RT_COOKIE_NAME: "x", RT_COOKIE_PATH: "/y" });
    expect(cfg.jwtAccessTtl).toBe(60);
    expect(cfg.jwtRefreshTtl).toBe(120);
    expect(cfg.rtCookieSecure).toBe(true);
    expect(cfg.rtCookieName).toBe("x");
    expect(cfg.rtCookiePath).toBe("/y");
  });
});
```

- [ ] **Step 2: Run it, confirm it fails** — `pnpm jest packages/shared/test/config.spec.ts` (fails: fields undefined / 3600).

- [ ] **Step 3: Add the Prisma models** — append to `packages/shared/prisma/schema.prisma` (after the `User` model):
```prisma
model RefreshToken {
  id        String    @id @default(uuid())
  familyId  String    @map("family_id")
  userId    String    @map("user_id")
  tenantId  String    @map("tenant_id")
  tokenHash String    @unique @map("token_hash")
  status    String    @default("active")
  expiresAt DateTime  @map("expires_at")
  createdAt DateTime  @default(now()) @map("created_at")
  rotatedAt DateTime? @map("rotated_at")
  revokedAt DateTime? @map("revoked_at")

  @@index([familyId])
  @@index([userId])
  @@map("refresh_tokens")
}

model SigningKey {
  kid        String   @id
  alg        String   @default("RS256")
  privateJwk String   @map("private_jwk")
  publicJwk  String   @map("public_jwk")
  status     String   @default("current")
  createdAt  DateTime @default(now()) @map("created_at")

  @@map("signing_keys")
}
```

- [ ] **Step 4: Write the migration** — create `packages/shared/prisma/migrations/20260622000000_refresh_tokens_signing_keys/migration.sql`:
```sql
CREATE TABLE "refresh_tokens" (
    "id" TEXT NOT NULL,
    "family_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotated_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");
CREATE INDEX "refresh_tokens_family_id_idx" ON "refresh_tokens"("family_id");
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

CREATE TABLE "signing_keys" (
    "kid" TEXT NOT NULL,
    "alg" TEXT NOT NULL DEFAULT 'RS256',
    "private_jwk" TEXT NOT NULL,
    "public_jwk" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'current',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "signing_keys_pkey" PRIMARY KEY ("kid")
);
```

- [ ] **Step 5: Add config fields** — in `packages/shared/src/config.ts`, add to the `AppConfig` interface (after `jwtAccessTtl: number;`):
```ts
  jwtRefreshTtl: number;
  rtCookieName: string;
  rtCookieSecure: boolean;
  rtCookiePath: string;
```
Change the `jwtAccessTtl` line in `loadConfig`'s returned object from `Number(env.JWT_ACCESS_TTL ?? 3600)` to `Number(env.JWT_ACCESS_TTL ?? 900)`, and add (right after that line):
```ts
    jwtRefreshTtl: Number(env.JWT_REFRESH_TTL ?? 2592000),
    rtCookieName: env.RT_COOKIE_NAME ?? "fb_rt",
    rtCookieSecure: (env.RT_COOKIE_SECURE ?? "false") === "true",
    rtCookiePath: env.RT_COOKIE_PATH ?? "/api/identity/auth",
```

- [ ] **Step 6: Update the stale e2e assertion** — in `apps/identity/test/auth.e2e-spec.ts`, change line 39 `expect(res.body.expiresIn).toBe(3600);` to `expect(res.body.expiresIn).toBe(900);`.

- [ ] **Step 7: Apply migration + regenerate client** — run `pnpm db:deploy` then `pnpm db:generate` (expect: migration `20260622000000_refresh_tokens_signing_keys` applied; Prisma Client regenerated).

- [ ] **Step 8: Run config test + existing identity e2e** — `pnpm jest packages/shared/test/config.spec.ts apps/identity/test/auth.e2e-spec.ts` (expect PASS; requires infra up + DB migrated).

- [ ] **Step 9: Commit**
```bash
git add packages/shared/prisma/schema.prisma packages/shared/prisma/migrations/20260622000000_refresh_tokens_signing_keys packages/shared/src/config.ts packages/shared/test/config.spec.ts apps/identity/test/auth.e2e-spec.ts
git commit -m "feat(identity): refresh_tokens + signing_keys models, AT/RT + cookie config (AT TTL 900)"
```

---

## Task 2: KeyService — persist + rotate the signing key

**Files:**
- Modify: `apps/identity/src/auth/key.service.ts`
- Test: `apps/identity/test/key.service.spec.ts`

**Interfaces:**
- Consumes: `prisma.signingKey` (Task 1), `PrismaService` from `@flashbite/shared`.
- Produces: `KeyService.signingKey(): { key: KeyLike; kid: string; alg: string }` (unchanged shape, now from the persisted current key), `KeyService.jwks(): { keys: JWK[] }` (current+previous), `KeyService.rotate(): Promise<void>`.

- [ ] **Step 1: Write the failing test** — create `apps/identity/test/key.service.spec.ts`:
```ts
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
    for (const f of ["d", "p", "q", "dp", "dq", "qi"]) expect((jwk as Record<string, unknown>)[f]).toBeUndefined();
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
```

- [ ] **Step 2: Run it, confirm it fails** — `pnpm jest apps/identity/test/key.service.spec.ts` (fails: `KeyService` has no `prisma` ctor arg / no `rotate`).

- [ ] **Step 3: Rewrite KeyService** — replace `apps/identity/src/auth/key.service.ts` entirely:
```ts
import { Injectable, OnModuleInit } from "@nestjs/common";
import {
  generateKeyPair, exportJWK, importJWK, calculateJwkThumbprint, type KeyLike, type JWK,
} from "jose";
import { PrismaService } from "@flashbite/shared";

const ALG = "RS256";

/**
 * RSA signing key, persisted in `signing_keys` so identity restarts no longer invalidate every
 * issued token. JWKS publishes the `current` + `previous` keys so a deliberate rotation does not
 * break in-flight access tokens (their `kid` stays resolvable until the key is retired).
 */
@Injectable()
export class KeyService implements OnModuleInit {
  private currentKid!: string;
  private currentKey!: KeyLike;
  private publicJwks: JWK[] = [];

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.load();
  }

  private async load(): Promise<void> {
    let current = await this.prisma.signingKey.findFirst({ where: { status: "current" } });
    if (!current) {
      current = await this.generate();
    }
    const rows = await this.prisma.signingKey.findMany({ where: { status: { in: ["current", "previous"] } } });
    this.currentKid = current.kid;
    this.currentKey = (await importJWK(JSON.parse(current.privateJwk) as JWK, ALG)) as KeyLike;
    this.publicJwks = rows.map((r) => ({ ...(JSON.parse(r.publicJwk) as JWK), kid: r.kid, alg: ALG, use: "sig" }));
  }

  private async generate(): Promise<{ kid: string; privateJwk: string }> {
    // extractable:true so exportJWK() can serialize BOTH keys for persistence.
    const { publicKey, privateKey } = await generateKeyPair(ALG, { extractable: true });
    const pubJwk = await exportJWK(publicKey);
    const privJwk = await exportJWK(privateKey);
    const kid = await calculateJwkThumbprint(pubJwk);
    return this.prisma.signingKey.create({
      data: { kid, alg: ALG, publicJwk: JSON.stringify(pubJwk), privateJwk: JSON.stringify(privJwk), status: "current" },
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
```

- [ ] **Step 4: Run the test, confirm pass** — `pnpm jest apps/identity/test/key.service.spec.ts` (expect PASS). Also re-run `pnpm jest apps/identity/test/jwks.e2e-spec.ts apps/identity/test/auth.e2e-spec.ts` (expect PASS — `keys[0]` is still the current key, login still verifies via JWKS).

- [ ] **Step 5: Commit**
```bash
git add apps/identity/src/auth/key.service.ts apps/identity/test/key.service.spec.ts
git commit -m "feat(identity): persist RSA signing key + current/previous JWKS rotation"
```

---

## Task 3: RefreshTokenService — issue / rotate / reuse-detect / revoke

**Files:**
- Create: `apps/identity/src/auth/refresh-token.service.ts`
- Test: `apps/identity/test/refresh-token.service.spec.ts`

**Interfaces:**
- Consumes: `prisma.refreshToken` (Task 1), `PrismaService`, `loadConfig`.
- Produces:
  - `RefreshTokenService.issue(userId, tenantId): Promise<{ raw: string; expiresAt: Date }>`
  - `RefreshTokenService.rotate(raw): Promise<RotateResult>` where `type RotateResult = { ok: true; raw: string; expiresAt: Date; userId: string } | { ok: false; reason: "reuse" | "invalid" }`
  - `RefreshTokenService.revoke(raw): Promise<void>`

- [ ] **Step 1: Write the failing test** — create `apps/identity/test/refresh-token.service.spec.ts`:
```ts
import "reflect-metadata";
import { PrismaService } from "@flashbite/shared";
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

  it("reuse of a rotated token revokes the whole family", async () => {
    const { raw } = await svc.issue(userId, tenantId);
    const first = await svc.rotate(raw);
    expect(first.ok).toBe(true);
    const reuse = await svc.rotate(raw); // raw was already rotated
    expect(reuse).toEqual({ ok: false, reason: "reuse" });
    const familyId = (await prisma.refreshToken.findUnique({ where: { tokenHash: sha(raw) } }))!.familyId;
    const rows = await prisma.refreshToken.findMany({ where: { familyId } });
    expect(rows.every((r) => r.status === "revoked")).toBe(true);
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
```

- [ ] **Step 2: Run it, confirm it fails** — `pnpm jest apps/identity/test/refresh-token.service.spec.ts` (fails: module not found).

- [ ] **Step 3: Implement** — create `apps/identity/src/auth/refresh-token.service.ts`:
```ts
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
```

- [ ] **Step 4: Run the test, confirm pass** — `pnpm jest apps/identity/test/refresh-token.service.spec.ts` (expect PASS).

- [ ] **Step 5: Commit**
```bash
git add apps/identity/src/auth/refresh-token.service.ts apps/identity/test/refresh-token.service.spec.ts
git commit -m "feat(identity): RefreshTokenService — rotating, reuse-detecting, hashed refresh tokens"
```

---

## Task 4: Cookie helper (pure)

**Files:**
- Create: `apps/identity/src/auth/cookie.ts`
- Test: `apps/identity/test/cookie.spec.ts`

**Interfaces:**
- Produces:
  - `parseCookie(header: string | undefined, name: string): string | undefined`
  - `buildSetCookie(name, value, opts: { maxAgeSeconds: number; secure: boolean; path: string }): string`
  - `clearSetCookie(name: string, path: string): string`

- [ ] **Step 1: Write the failing test** — create `apps/identity/test/cookie.spec.ts`:
```ts
import { parseCookie, buildSetCookie, clearSetCookie } from "../src/auth/cookie";

describe("cookie helpers", () => {
  it("parses a named cookie from the header", () => {
    expect(parseCookie("a=1; fb_rt=xyz; b=2", "fb_rt")).toBe("xyz");
    expect(parseCookie("a=1", "fb_rt")).toBeUndefined();
    expect(parseCookie(undefined, "fb_rt")).toBeUndefined();
  });

  it("builds an httpOnly SameSite=Strict Set-Cookie with Secure gated", () => {
    const secure = buildSetCookie("fb_rt", "v", { maxAgeSeconds: 100, secure: true, path: "/api/identity/auth" });
    expect(secure).toContain("fb_rt=v");
    expect(secure).toContain("Max-Age=100");
    expect(secure).toContain("Path=/api/identity/auth");
    expect(secure).toContain("HttpOnly");
    expect(secure).toContain("SameSite=Strict");
    expect(secure).toContain("Secure");
    const insecure = buildSetCookie("fb_rt", "v", { maxAgeSeconds: 100, secure: false, path: "/p" });
    expect(insecure).not.toContain("Secure");
  });

  it("clears the cookie with Max-Age=0", () => {
    const c = clearSetCookie("fb_rt", "/api/identity/auth");
    expect(c).toContain("fb_rt=;");
    expect(c).toContain("Max-Age=0");
    expect(c).toContain("Path=/api/identity/auth");
  });
});
```

- [ ] **Step 2: Run it, confirm it fails** — `pnpm jest apps/identity/test/cookie.spec.ts` (fails: module not found).

- [ ] **Step 3: Implement** — create `apps/identity/src/auth/cookie.ts`:
```ts
/** Read one named cookie out of a raw `Cookie` request header. */
export function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

export interface CookieOpts {
  maxAgeSeconds: number;
  secure: boolean;
  path: string;
}

/** Build an httpOnly, SameSite=Strict Set-Cookie value (Secure only when opts.secure). */
export function buildSetCookie(name: string, value: string, opts: CookieOpts): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Max-Age=${opts.maxAgeSeconds}`,
    `Path=${opts.path}`,
    "HttpOnly",
    "SameSite=Strict",
  ];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

/** Build a Set-Cookie that immediately expires the cookie. */
export function clearSetCookie(name: string, path: string): string {
  return `${name}=; Max-Age=0; Path=${path}; HttpOnly; SameSite=Strict`;
}
```

- [ ] **Step 4: Run the test, confirm pass** — `pnpm jest apps/identity/test/cookie.spec.ts` (expect PASS).

- [ ] **Step 5: Commit**
```bash
git add apps/identity/src/auth/cookie.ts apps/identity/test/cookie.spec.ts
git commit -m "feat(identity): cookie parse/build/clear helpers"
```

---

## Task 5: AuthService + AuthController — login sets RT cookie, refresh, logout

**Files:**
- Modify: `apps/identity/src/auth/auth.service.ts`
- Modify: `apps/identity/src/auth/auth.controller.ts`
- Modify: `apps/identity/src/auth/auth.module.ts`
- Test: `apps/identity/test/refresh.e2e-spec.ts`

**Interfaces:**
- Consumes: `RefreshTokenService` (Task 3), cookie helpers (Task 4), `TokenService`/`KeyService` (existing/Task 2), `prisma.user`.
- Produces: `POST /auth/login` (sets `fb_rt` cookie, returns AT body unchanged), `POST /auth/refresh` (cookie-only → new AT + rotated cookie), `POST /auth/logout` (cookie-only → revokes + clears).

- [ ] **Step 1: Write the failing e2e** — create `apps/identity/test/refresh.e2e-spec.ts`:
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
```

- [ ] **Step 2: Run it, confirm it fails** — `pnpm jest apps/identity/test/refresh.e2e-spec.ts` (fails: no cookie set / no refresh route).

- [ ] **Step 3: Extend AuthService** — replace `apps/identity/src/auth/auth.service.ts` body. Keep `LoginResult`; add the refresh service + the two new methods:
```ts
import { Injectable, UnauthorizedException } from "@nestjs/common";
import argon2 from "argon2";
import { PrismaService } from "@flashbite/shared";
import { TokenService } from "./token.service";
import { RefreshTokenService } from "./refresh-token.service";

export interface LoginResult {
  accessToken: string;
  tokenType: "Bearer";
  expiresIn: number;
}

export interface AuthIssue {
  access: LoginResult;
  refresh: { raw: string; expiresAt: Date };
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly refreshTokens: RefreshTokenService,
  ) {}

  private async access(user: { id: string; tenantId: string; role: string }): Promise<LoginResult> {
    const accessToken = await this.tokens.sign({ sub: user.id, tenantId: user.tenantId, role: user.role });
    return { accessToken, tokenType: "Bearer", expiresIn: this.tokens.ttlSeconds() };
  }

  async login(email: string, password: string): Promise<AuthIssue> {
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
    const access = await this.access(user);
    const refresh = await this.refreshTokens.issue(user.id, user.tenantId);
    return { access, refresh };
  }

  /** Rotate the refresh token and mint a fresh access token from the user's CURRENT role/tenant. */
  async refresh(rawToken: string): Promise<AuthIssue> {
    const r = await this.refreshTokens.rotate(rawToken);
    if (!r.ok) throw new UnauthorizedException("Invalid refresh token");
    const user = await this.prisma.user.findUnique({ where: { id: r.userId } });
    if (!user) throw new UnauthorizedException("Invalid refresh token");
    const access = await this.access(user);
    return { access, refresh: { raw: r.raw, expiresAt: r.expiresAt } };
  }

  async logout(rawToken: string): Promise<void> {
    await this.refreshTokens.revoke(rawToken);
  }
}
```

- [ ] **Step 4: Rewrite AuthController** — replace `apps/identity/src/auth/auth.controller.ts`:
```ts
import { Body, Controller, HttpCode, Post, Req, Res } from "@nestjs/common";
import { UnauthorizedException } from "@nestjs/common";
import { loadConfig, type AppConfig } from "@flashbite/shared";
import { AuthService, type LoginResult } from "./auth.service";
import { LoginDto } from "./login.dto";
import { parseCookie, buildSetCookie, clearSetCookie } from "./cookie";

// Minimal structural types — avoids depending on @types/express.
type ReqLike = { headers: { cookie?: string } };
type ResLike = { setHeader: (name: string, value: string) => void };

@Controller("auth")
export class AuthController {
  private readonly cfg: AppConfig = loadConfig();
  constructor(private readonly auth: AuthService) {}

  private setRt(res: ResLike, raw: string): void {
    res.setHeader(
      "Set-Cookie",
      buildSetCookie(this.cfg.rtCookieName, raw, {
        maxAgeSeconds: this.cfg.jwtRefreshTtl,
        secure: this.cfg.rtCookieSecure,
        path: this.cfg.rtCookiePath,
      }),
    );
  }
  private clearRt(res: ResLike): void {
    res.setHeader("Set-Cookie", clearSetCookie(this.cfg.rtCookieName, this.cfg.rtCookiePath));
  }

  @Post("login")
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: ResLike): Promise<LoginResult> {
    const { access, refresh } = await this.auth.login(dto.email, dto.password);
    this.setRt(res, refresh.raw);
    return access;
  }

  @Post("refresh")
  @HttpCode(200)
  async refresh(@Req() req: ReqLike, @Res({ passthrough: true }) res: ResLike): Promise<LoginResult> {
    const raw = parseCookie(req.headers.cookie, this.cfg.rtCookieName);
    if (!raw) {
      this.clearRt(res);
      throw new UnauthorizedException("No refresh token");
    }
    try {
      const { access, refresh } = await this.auth.refresh(raw);
      this.setRt(res, refresh.raw);
      return access;
    } catch (e) {
      this.clearRt(res);
      throw e;
    }
  }

  @Post("logout")
  @HttpCode(204)
  async logout(@Req() req: ReqLike, @Res({ passthrough: true }) res: ResLike): Promise<void> {
    const raw = parseCookie(req.headers.cookie, this.cfg.rtCookieName);
    if (raw) await this.auth.logout(raw);
    this.clearRt(res);
  }
}
```

- [ ] **Step 5: Register RefreshTokenService** — in `apps/identity/src/auth/auth.module.ts`, import it and add to `providers`:
```ts
import { RefreshTokenService } from "./refresh-token.service";
// ...
  providers: [KeyService, TokenService, RefreshTokenService, AuthService, PrismaService],
```

- [ ] **Step 6: Run the e2e + the existing auth e2e** — `pnpm jest apps/identity/test/refresh.e2e-spec.ts apps/identity/test/auth.e2e-spec.ts` (expect PASS).

- [ ] **Step 7: Commit**
```bash
git add apps/identity/src/auth/auth.service.ts apps/identity/src/auth/auth.controller.ts apps/identity/src/auth/auth.module.ts apps/identity/test/refresh.e2e-spec.ts
git commit -m "feat(identity): login sets rotating RT cookie; /auth/refresh + /auth/logout"
```

---

## Task 6: web-shared — silent refresh-on-401 + server logout

**Files:**
- Modify: `packages/web-shared/src/api/client.ts`
- Modify: `packages/web-shared/src/store/auth-store.ts`
- Test: `packages/web-shared/src/api/client.test.ts`

**Interfaces:**
- Consumes: `POST /api/identity/auth/refresh` and `/logout` (Task 5), `useAuthStore`.
- Produces: `authedFetch` now refreshes once on 401 (single-flight) and retries; `useAuthStore.setToken(token)`; `logout()` calls the server then clears.

- [ ] **Step 1: Write the failing tests** — add `getOrderDriverLocation` is unrelated; here add to `packages/web-shared/src/api/client.test.ts` inside `describe("api client", ...)`:
```ts
  it("refreshes once on 401, then retries the original request with the new token", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("", { status: 401 }))                                         // original
      .mockResolvedValueOnce(new Response(JSON.stringify({ accessToken: "new-token" }), { status: 200 })) // refresh
      .mockResolvedValueOnce(new Response(JSON.stringify({ orderId: "o-1" }), { status: 200 }));         // retry
    const res = await placeOrder({ orderId: "o-1", customerId: "a", items: [], totalAmount: 0 });
    expect(res).toEqual({ orderId: "o-1" });
    expect(fetchMock.mock.calls[1][0]).toBe("/api/identity/auth/refresh");
    expect((fetchMock.mock.calls[1][1] as RequestInit).credentials).toBe("include");
    const retryHeaders = ((fetchMock.mock.calls[2][1] as RequestInit).headers ?? {}) as Record<string, string>;
    expect(retryHeaders.Authorization).toBe("Bearer new-token");
  });

  it("logs out and throws when the refresh also fails", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("", { status: 401 }))   // original
      .mockResolvedValueOnce(new Response("", { status: 401 }));  // refresh fails
    await expect(getOrder("o-1")).rejects.toBeInstanceOf(UnauthorizedError);
    expect(useAuthStore.getState().token).toBeNull();
  });

  it("single-flights concurrent 401s into one refresh", async () => {
    let refreshCalls = 0;
    const failedOnce = new Set<string>();
    fetchMock.mockImplementation((url: string) => {
      if (url === "/api/identity/auth/refresh") {
        refreshCalls += 1;
        return Promise.resolve(new Response(JSON.stringify({ accessToken: "new-token" }), { status: 200 }));
      }
      if (!failedOnce.has(url)) { failedOnce.add(url); return Promise.resolve(new Response("", { status: 401 })); }
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    });
    await Promise.all([getOrder("o-1"), listOrders()]);
    expect(refreshCalls).toBe(1);
  });
```

- [ ] **Step 2: Run, confirm fail** — `pnpm --filter @flashbite/web-shared test -- client` (fails: current `authedFetch` logs out immediately; no `setToken`).

- [ ] **Step 3: Add `setToken` + server logout to the store** — in `packages/web-shared/src/store/auth-store.ts`, extend the `AuthState` interface:
```ts
  setToken: (token: string) => void;
```
and in the store body, add `setToken` and replace `logout`:
```ts
      setToken: (token) => set({ token, claims: decodeClaims(token) }),
      logout: () => {
        // best-effort server revoke (clears the httpOnly RT cookie); state is cleared regardless.
        void fetch("/api/identity/auth/logout", { method: "POST", credentials: "include" }).catch(() => undefined);
        set({ token: null, claims: null });
      },
```
Also add `credentials: "include"` to the existing `login` fetch (so it receives the Set-Cookie):
```ts
        const res = await fetch("/api/identity/auth/login", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        });
```

- [ ] **Step 4: Rewrite the 401 path in `client.ts`** — replace the `authedFetch` definition (and add the refresh helpers above it):
```ts
/** Single-flight refresh: concurrent 401s share one /auth/refresh call. */
let refreshing: Promise<boolean> | null = null;

async function refreshSession(): Promise<boolean> {
  const res = await fetch("/api/identity/auth/refresh", { method: "POST", credentials: "include" });
  if (!res.ok) return false;
  const { accessToken } = (await res.json()) as { accessToken: string };
  useAuthStore.getState().setToken(accessToken);
  return true;
}

function ensureRefreshed(): Promise<boolean> {
  if (!refreshing) refreshing = refreshSession().finally(() => { refreshing = null; });
  return refreshing;
}

/** fetch + Bearer header; on 401 try ONE silent refresh + retry, else clear the session and throw. */
async function authedFetch(input: string, init: RequestInit = {}): Promise<Response> {
  let res = await fetch(input, { ...init, headers: { ...authHeader(), ...(init.headers ?? {}) } });
  if (res.status !== 401) return res;
  const ok = await ensureRefreshed();
  if (ok) {
    res = await fetch(input, { ...init, headers: { ...authHeader(), ...(init.headers ?? {}) } });
    if (res.status !== 401) return res;
  }
  useAuthStore.getState().logout();
  throw new UnauthorizedError();
}
```

- [ ] **Step 5: Run, confirm pass** — `pnpm --filter @flashbite/web-shared test -- client` (expect PASS, including the existing 401/Bearer tests).

- [ ] **Step 6: Commit**
```bash
git add packages/web-shared/src/api/client.ts packages/web-shared/src/store/auth-store.ts packages/web-shared/src/api/client.test.ts
git commit -m "feat(web-shared): silent single-flight refresh-on-401 + server logout"
```

---

## Task 7: env + requests.http + docs + full verification

**Files:**
- Modify: `.env.example`
- Modify: `apps/identity/requests.http` (or the repo's identity requests file — see step 1)
- Modify: `docs/ARCHITECTURE.md`, `README.md`

- [ ] **Step 1: Document env vars** — in `.env.example`, near the existing `JWT_ACCESS_TTL` line, set/append (ASCII only, match surrounding comment style):
```
# Identity tokens (Phase: AT/RT hardening)
JWT_ACCESS_TTL=900          # access-token TTL seconds (short-lived)
JWT_REFRESH_TTL=2592000     # refresh-token TTL seconds (~30d)
RT_COOKIE_NAME=fb_rt        # httpOnly refresh-token cookie name
RT_COOKIE_SECURE=false      # set true in prod (https); false for dev http
RT_COOKIE_PATH=/api/identity/auth  # browser-facing proxied path (NOT /auth)
```
If a `JWT_ACCESS_TTL` line already exists, update its value to 900 rather than duplicating.

- [ ] **Step 2: Add HTTP examples** — find the identity requests file (`rg -l "auth/login" --glob "*.http"`). Append refresh + logout examples after the existing login request, reusing the same base var:
```
### Refresh the access token (sends the fb_rt cookie set by login)
POST {{identityUrl}}/auth/refresh

### Logout (revokes the refresh token)
POST {{identityUrl}}/auth/logout
```
(Match the file's existing variable names for the identity base URL.)

- [ ] **Step 3: Update ARCHITECTURE.md** — in the identity/auth section, add a bullet (ASCII only, match style):
```
- **Access + refresh tokens (identity hardening):** login returns a short-lived RS256 access
  token (JWT_ACCESS_TTL=900s, body `{accessToken,tokenType,expiresIn}`) plus a server-tracked,
  rotating refresh token delivered ONLY as an httpOnly SameSite=Strict cookie (`fb_rt`, sha-256
  hashed at rest, never returned in a body). `POST /auth/refresh` rotates the RT (one-time-use;
  reusing a rotated/revoked RT revokes the whole token family) and mints a fresh AT; `POST
  /auth/logout` revokes it. web-shared `authedFetch` silently refreshes once on a 401 (single
  flight) and retries. The RSA signing key is persisted in `signing_keys`; JWKS publishes
  current+previous so a deliberate rotation never breaks in-flight access tokens. Resource-server
  token verification is unchanged (JWKS resolves multiple kids).
```

- [ ] **Step 4: Update README.md** — add a one-line mention under the identity/security feature list, e.g.:
```
- Identity hardening: short-lived access tokens + rotating httpOnly refresh-token cookies, persisted+rotatable signing key.
```
(Place it beside the existing JWT/identity bullet; match surrounding list style.)

- [ ] **Step 5: Full verification sweep** — run and confirm each passes (infra up + DB migrated from Task 1):
```bash
pnpm --filter @flashbite/web-shared test
pnpm jest apps/identity packages/shared/test/config.spec.ts
```
Expect: web-shared Vitest all pass; identity Jest (auth + refresh + jwks + key.service + refresh-token.service + cookie + health e2e) all pass; config spec passes.

- [ ] **Step 6: Commit**
```bash
git add .env.example docs/ARCHITECTURE.md README.md
git add -A "**/*.http"
git commit -m "docs(identity): AT/RT env, requests.http refresh/logout, ARCHITECTURE + README"
```

---

## Self-Review (completed by plan author)

**Spec coverage:** short AT (900) + config → Task 1; persisted signing key + current/previous JWKS rotation → Task 2; stateful rotating RT with reuse-detection + revoke + prune → Task 3; cookie helper → Task 4; login sets RT cookie + `/auth/refresh` + `/auth/logout` (cookie-only, theft response, 401 clears cookie) → Task 5; client silent single-flight refresh-on-401 + server logout + login stores AT only → Task 6; env + requests.http + ARCHITECTURE + README + full verification → Task 7. Resource servers unchanged (verified: `TokenVerifier` uses `createRemoteJWKSet`, multi-kid). ✓

**Type consistency:** `AuthIssue { access: LoginResult; refresh: { raw; expiresAt } }` produced by `AuthService.login/refresh`, consumed by `AuthController`. `RotateResult` discriminated union produced by `RefreshTokenService.rotate`, consumed by `AuthService.refresh`. `KeyService.signingKey()` shape unchanged so `TokenService.sign` is untouched. Cookie helper signatures (`parseCookie`/`buildSetCookie`/`clearSetCookie`) match their uses in the controller. `setToken` added to the store and used by `refreshSession`. AT login body shape `{accessToken,tokenType,expiresIn}` unchanged across the chain.

**Constraints surfaced:** raw RT never stored (only sha-256) — asserted in Task 3 tests; cookie `Path` is the browser-facing `/api/identity/auth` (Global Constraints + Task 1 config) to survive the Next rewrite; `Secure` gated by `RT_COOKIE_SECURE`; AT TTL default change (3600→900) ripples to the one existing e2e assertion, updated in Task 1; rotation/reuse semantics tested at both the service (Task 3) and HTTP (Task 5) layers.
