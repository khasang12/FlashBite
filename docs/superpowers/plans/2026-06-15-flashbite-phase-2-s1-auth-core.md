# Phase 2 — S1 (Auth Core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the trusted `X-Tenant-ID` header on write-api + read-api with a verified RS256 JWT (issued by the 2a identity service) as the sole source of `tenantId`/`role`/`sub`, enforced by a Bearer-required middleware and role guards.

**Architecture:** `@flashbite/tenant-context` is broadened into an *auth* context: a `TokenVerifier` (jose `createRemoteJWKSet` + `jwtVerify`, checking `iss`/`aud`/`exp`/signature) feeds an `AuthMiddleware` that stores `{tenantId, role, sub}` in `AsyncLocalStorage` and rejects requests lacking a valid Bearer token (401). A `RolesGuard` enforces `@Roles(...)` (403). `getTenantId()` keeps working (now reads the auth context); `getRole()`/`getAuthContext()` are added. Workers and the read model are untouched.

**Tech Stack:** NestJS 10, jose 5.9.6, Jest + supertest (e2e), TypeScript, pnpm workspaces.

**Scope:** S1 ONLY. No RLS (S2), no operator API (S3), no frontend (S4). The frontends, the gps script, and Playwright e2e still send `X-Tenant-ID` and will break after this slice — that is expected and is fixed in S4. This slice migrates only `apps/write-api/requests.http` and the **backend Jest e2e** (write-api + read-api) to Bearer.

**Branch:** `phase-2-s1-auth-core` (already created off `main`; the design spec is already committed there).

---

## File Structure

**`@flashbite/tenant-context` (package — broadened to auth context):**
- Create `packages/tenant-context/src/auth-context.ts` — `AsyncLocalStorage<{tenantId, role, sub}>`; `runWithAuth`, `getAuthContext`, `getTenantId`, `getRole`, `AuthContextError`.
- Create `packages/tenant-context/src/token-verifier.ts` — `TokenVerifier` (`@Injectable`): verifies a JWT and returns the auth context. Default ctor builds a remote JWKS resolver from config; accepts an injected resolver for tests.
- Create `packages/tenant-context/src/auth.middleware.ts` — `AuthMiddleware`: extract Bearer, verify, `runWithAuth(...)`; 401 on missing/invalid.
- Create `packages/tenant-context/src/roles.guard.ts` — `@Roles(...)` decorator + `RolesGuard` (403 on mismatch).
- Create `packages/tenant-context/src/testing.ts` — `createTestAuth()` test helper (local keypair + JWKS + `mint()`), used by e2e to issue tokens without the network/identity service.
- Modify `packages/tenant-context/src/index.ts` — export the new surface; stop exporting the old tenant middleware/context.
- Delete `packages/tenant-context/src/tenant-context.ts` and `packages/tenant-context/src/tenant.middleware.ts` (replaced).
- Modify `packages/tenant-context/src/tenant-context.spec.ts` → rename/replace with `auth-context.spec.ts`.
- Create `packages/tenant-context/src/token-verifier.spec.ts`, `packages/tenant-context/src/roles.guard.spec.ts`.
- Modify `packages/tenant-context/package.json` — add `jose@5.9.6`.

**`@flashbite/shared`:**
- Modify `packages/shared/src/config.ts` — add `jwtJwksUrl`.
- Modify `packages/shared/src/config.spec.ts` — assert the default.

**Build/test config (for the e2e test helper subpath):**
- Modify `jest.config.cjs` and `tsconfig.json` — map `@flashbite/tenant-context/testing` → `packages/tenant-context/src/testing.ts` so app e2e specs can import the helper without it living in the package's runtime entrypoint.

**`apps/write-api`:**
- Modify `apps/write-api/src/app.module.ts` — `AuthMiddleware` (exclude `health`), global `RolesGuard`, provide `TokenVerifier`.
- Modify `apps/write-api/src/health.controller.ts` — drop `tenantId` (health is unauthenticated).
- Modify `apps/write-api/src/orders/orders.controller.ts` — `@Roles("customer")`.
- Modify `apps/write-api/src/orders/accept.controller.ts` — `@Roles("merchant")`.
- Modify `apps/write-api/test/health.e2e-spec.ts`, `orders.e2e-spec.ts`, `accept.e2e-spec.ts` — Bearer.

**`apps/read-api`:**
- Modify `apps/read-api/src/app.module.ts` — `AuthMiddleware` (exclude `health`), provide `TokenVerifier`.
- Modify `apps/read-api/src/health.controller.ts` — drop `tenantId`.
- Modify all `apps/read-api/test/*.e2e-spec.ts` that send `X-Tenant-ID` — Bearer.

**Docs:**
- Modify `apps/write-api/requests.http` — add `Authorization: Bearer {{login.response.body.$.accessToken}}`; remove `X-Tenant-ID`.

---

## Task 1: Auth context (AsyncLocalStorage of tenant + role + sub)

**Files:**
- Create: `packages/tenant-context/src/auth-context.ts`
- Create: `packages/tenant-context/src/auth-context.spec.ts`
- Delete: `packages/tenant-context/src/tenant-context.ts`, `packages/tenant-context/src/tenant-context.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/tenant-context/src/auth-context.spec.ts`:

```ts
import {
  runWithAuth,
  getAuthContext,
  getTenantId,
  getRole,
  AuthContextError,
  type AuthContext,
} from "./auth-context";

const ctx: AuthContext = { tenantId: "berlin", role: "customer", sub: "c-1" };

describe("auth context", () => {
  it("exposes tenantId, role and the full context inside the run scope", () => {
    const seen = runWithAuth(ctx, () => ({
      tenantId: getTenantId(),
      role: getRole(),
      all: getAuthContext(),
    }));
    expect(seen.tenantId).toBe("berlin");
    expect(seen.role).toBe("customer");
    expect(seen.all).toEqual(ctx);
  });

  it("throws when read outside any scope", () => {
    expect(() => getTenantId()).toThrow(AuthContextError);
    expect(() => getRole()).toThrow(AuthContextError);
    expect(() => getAuthContext()).toThrow(AuthContextError);
  });

  it("isolates nested scopes", () => {
    runWithAuth(ctx, () => {
      const inner = runWithAuth({ tenantId: "tokyo", role: "merchant", sub: "m-1" }, () =>
        getTenantId(),
      );
      expect(inner).toBe("tokyo");
      expect(getTenantId()).toBe("berlin");
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec jest packages/tenant-context/src/auth-context.spec.ts`
Expected: FAIL — cannot find module `./auth-context`.

- [ ] **Step 3: Delete the old tenant-context files and write the implementation**

Delete `packages/tenant-context/src/tenant-context.ts` and `packages/tenant-context/src/tenant-context.spec.ts`.

Create `packages/tenant-context/src/auth-context.ts`:

```ts
import { AsyncLocalStorage } from "node:async_hooks";

export class AuthContextError extends Error {}

export interface AuthContext {
  tenantId: string;
  role: string;
  sub: string;
}

const storage = new AsyncLocalStorage<AuthContext>();

export function runWithAuth<T>(ctx: AuthContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getAuthContext(): AuthContext {
  const ctx = storage.getStore();
  if (!ctx) {
    throw new AuthContextError("No auth context in scope");
  }
  return ctx;
}

export function getTenantId(): string {
  return getAuthContext().tenantId;
}

export function getRole(): string {
  return getAuthContext().role;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec jest packages/tenant-context/src/auth-context.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/tenant-context/src/auth-context.ts packages/tenant-context/src/auth-context.spec.ts
git rm packages/tenant-context/src/tenant-context.ts packages/tenant-context/src/tenant-context.spec.ts
git commit -m "refactor(tenant-context): replace tenant context with auth context (tenantId+role+sub)"
```

---

## Task 2: TokenVerifier (jose verify against JWKS) + test helper

**Files:**
- Modify: `packages/tenant-context/package.json` (add `jose@5.9.6`)
- Create: `packages/tenant-context/src/token-verifier.ts`
- Create: `packages/tenant-context/src/testing.ts`
- Create: `packages/tenant-context/src/token-verifier.spec.ts`

**Context:** The 2a identity service signs RS256 tokens with claims `tenantId`, `role`, subject (`sub`), `iss`, `aud`, `exp` and a header `kid` (see `apps/identity/src/auth/token.service.ts`). The verifier must fetch the public keys from the identity JWKS endpoint and check the signature + `iss`/`aud`/`exp`. `jose.createRemoteJWKSet` handles JWKS fetch/cache and refetch-on-unknown-`kid` (matching 2a's startup-regenerated keys). For tests, `createTestAuth()` builds a local keypair + `createLocalJWKSet` resolver so no network or identity process is needed.

- [ ] **Step 1: Add the jose dependency**

Edit `packages/tenant-context/package.json` — add to `dependencies` (keep alphabetical-ish; matching identity's pin `5.9.6`):

```json
  "dependencies": {
    "@flashbite/shared": "workspace:*",
    "@nestjs/common": "10.4.4",
    "jose": "5.9.6"
  },
```

Run: `pnpm install`
Expected: lockfile updates; `jose@5.9.6` resolved for `@flashbite/tenant-context`.

- [ ] **Step 2: Write the failing test**

Create `packages/tenant-context/src/token-verifier.spec.ts`:

```ts
import { SignJWT } from "jose";
import { createTestAuth } from "./testing";

describe("TokenVerifier", () => {
  it("verifies a well-formed token and returns the auth context", async () => {
    const { verifier, mint } = await createTestAuth();
    const token = await mint({ tenantId: "berlin", role: "customer", sub: "c-1" });
    const ctx = await verifier.verify(token);
    expect(ctx).toEqual({ tenantId: "berlin", role: "customer", sub: "c-1" });
  });

  it("rejects a token with the wrong issuer", async () => {
    const { verifier, signWith, kid } = await createTestAuth();
    const bad = await new SignJWT({ tenantId: "berlin", role: "customer" })
      .setProtectedHeader({ alg: "RS256", kid })
      .setSubject("c-1")
      .setIssuer("someone-else")
      .setAudience("flashbite")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(signWith);
    await expect(verifier.verify(bad)).rejects.toThrow();
  });

  it("rejects an expired token", async () => {
    const { verifier, signWith, kid } = await createTestAuth();
    const expired = await new SignJWT({ tenantId: "berlin", role: "customer" })
      .setProtectedHeader({ alg: "RS256", kid })
      .setSubject("c-1")
      .setIssuer("flashbite-identity")
      .setAudience("flashbite")
      .setIssuedAt(0)
      .setExpirationTime(1) // epoch second 1 — long past
      .sign(signWith);
    await expect(verifier.verify(expired)).rejects.toThrow();
  });

  it("rejects a tampered token", async () => {
    const { verifier, mint } = await createTestAuth();
    const token = await mint({ tenantId: "berlin", role: "customer", sub: "c-1" });
    const tampered = token.slice(0, -3) + "AAA";
    await expect(verifier.verify(tampered)).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm exec jest packages/tenant-context/src/token-verifier.spec.ts`
Expected: FAIL — cannot find module `./testing` / `./token-verifier`.

- [ ] **Step 4: Write the implementation**

Create `packages/tenant-context/src/token-verifier.ts`:

```ts
import { Injectable, Optional } from "@nestjs/common";
import { jwtVerify, createRemoteJWKSet, type JWTVerifyGetKey } from "jose";
import { loadConfig } from "@flashbite/shared";
import type { AuthContext } from "./auth-context";

export interface TokenVerifierOptions {
  keyResolver?: JWTVerifyGetKey;
  issuer?: string;
  audience?: string;
}

/**
 * Verifies RS256 JWTs against the identity JWKS and maps claims to an AuthContext.
 * Default ctor builds a remote JWKS resolver from config; tests inject a local one.
 */
@Injectable()
export class TokenVerifier {
  private readonly keyResolver: JWTVerifyGetKey;
  private readonly issuer: string;
  private readonly audience: string;

  constructor(@Optional() opts?: TokenVerifierOptions) {
    const cfg = loadConfig();
    this.issuer = opts?.issuer ?? cfg.jwtIssuer;
    this.audience = opts?.audience ?? cfg.jwtAudience;
    this.keyResolver = opts?.keyResolver ?? createRemoteJWKSet(new URL(cfg.jwtJwksUrl));
  }

  async verify(token: string): Promise<AuthContext> {
    const { payload } = await jwtVerify(token, this.keyResolver, {
      issuer: this.issuer,
      audience: this.audience,
    });
    const tenantId = payload.tenantId;
    const role = payload.role;
    const sub = payload.sub;
    if (typeof tenantId !== "string" || typeof role !== "string" || typeof sub !== "string") {
      throw new Error("token missing required claims");
    }
    return { tenantId, role, sub };
  }
}
```

Create `packages/tenant-context/src/testing.ts`:

```ts
import {
  generateKeyPair,
  exportJWK,
  calculateJwkThumbprint,
  createLocalJWKSet,
  SignJWT,
  type KeyLike,
  type JWK,
} from "jose";
import { TokenVerifier } from "./token-verifier";
import type { AuthContext } from "./auth-context";

const ALG = "RS256";

export interface TestAuth {
  /** A TokenVerifier wired to a local in-memory JWKS — inject via overrideProvider. */
  verifier: TokenVerifier;
  /** Mint a valid token for the given context (1h expiry). */
  mint: (ctx: AuthContext) => Promise<string>;
  /** The private key, for hand-rolling malformed tokens in tests. */
  signWith: KeyLike;
  /** The key id used in minted token headers. */
  kid: string;
}

/**
 * Builds a self-contained auth fixture: a fresh RS256 keypair, a TokenVerifier
 * backed by a local JWKS (no network / no identity service), and a mint() helper.
 * issuer/audience default to the project defaults so minted tokens verify.
 */
export async function createTestAuth(opts?: { issuer?: string; audience?: string }): Promise<TestAuth> {
  const issuer = opts?.issuer ?? "flashbite-identity";
  const audience = opts?.audience ?? "flashbite";
  const { publicKey, privateKey } = await generateKeyPair(ALG, { extractable: true });
  const jwk = await exportJWK(publicKey);
  const kid = await calculateJwkThumbprint(jwk);
  const publicJwk: JWK = { ...jwk, kid, alg: ALG, use: "sig" };
  const keyResolver = createLocalJWKSet({ keys: [publicJwk] });
  const verifier = new TokenVerifier({ keyResolver, issuer, audience });

  const mint = (ctx: AuthContext): Promise<string> =>
    new SignJWT({ tenantId: ctx.tenantId, role: ctx.role })
      .setProtectedHeader({ alg: ALG, kid })
      .setSubject(ctx.sub)
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);

  return { verifier, mint, signWith: privateKey, kid };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm exec jest packages/tenant-context/src/token-verifier.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/tenant-context/package.json packages/tenant-context/src/token-verifier.ts packages/tenant-context/src/testing.ts packages/tenant-context/src/token-verifier.spec.ts pnpm-lock.yaml
git commit -m "feat(tenant-context): TokenVerifier (jose JWKS verify) + createTestAuth helper"
```

---

## Task 3: AuthMiddleware (Bearer-required, 401)

**Files:**
- Create: `packages/tenant-context/src/auth.middleware.ts`
- Create: `packages/tenant-context/src/auth.middleware.spec.ts`
- Delete: `packages/tenant-context/src/tenant.middleware.ts`

**Context:** The middleware runs before guards/controllers and establishes the AsyncLocalStorage scope by calling `runWithAuth(ctx, () => next())` — the same pattern the deleted `TenantMiddleware` used with `runWithTenant`, so downstream guards and services read the context via `getTenantId()`/`getRole()`. Missing or invalid token → throw `UnauthorizedException` (Nest renders 401).

- [ ] **Step 1: Write the failing test**

Create `packages/tenant-context/src/auth.middleware.spec.ts`:

```ts
import { UnauthorizedException } from "@nestjs/common";
import { AuthMiddleware } from "./auth.middleware";
import { getAuthContext } from "./auth-context";
import { createTestAuth, type TestAuth } from "./testing";

describe("AuthMiddleware", () => {
  let auth: TestAuth;
  let mw: AuthMiddleware;

  beforeAll(async () => {
    auth = await createTestAuth();
    mw = new AuthMiddleware(auth.verifier);
  });

  const reqWith = (header?: string) =>
    ({ headers: header ? { authorization: header } : {} }) as any;

  it("runs next within the auth scope for a valid Bearer token", async () => {
    const token = await auth.mint({ tenantId: "berlin", role: "customer", sub: "c-1" });
    let seen: unknown;
    await mw.use(reqWith(`Bearer ${token}`), {} as any, () => {
      seen = getAuthContext();
    });
    expect(seen).toEqual({ tenantId: "berlin", role: "customer", sub: "c-1" });
  });

  it("rejects a request with no Authorization header (401)", async () => {
    await expect(mw.use(reqWith(undefined), {} as any, () => undefined)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it("rejects a non-Bearer Authorization header (401)", async () => {
    await expect(
      mw.use(reqWith("Basic abc"), {} as any, () => undefined),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("rejects an invalid token (401)", async () => {
    await expect(
      mw.use(reqWith("Bearer not.a.jwt"), {} as any, () => undefined),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec jest packages/tenant-context/src/auth.middleware.spec.ts`
Expected: FAIL — cannot find module `./auth.middleware`.

- [ ] **Step 3: Delete the old middleware and write the implementation**

Delete `packages/tenant-context/src/tenant.middleware.ts`.

Create `packages/tenant-context/src/auth.middleware.ts`:

```ts
import { Injectable, NestMiddleware, UnauthorizedException } from "@nestjs/common";
import { Request, Response, NextFunction } from "express";
import { runWithAuth } from "./auth-context";
import { TokenVerifier } from "./token-verifier";

/**
 * Phase 2: tenant + role come ONLY from a verified RS256 JWT. No X-Tenant-ID
 * fallback. Missing/invalid token -> 401. Establishes the auth context for the
 * request so guards/controllers/services read it via getTenantId()/getRole().
 */
@Injectable()
export class AuthMiddleware implements NestMiddleware {
  constructor(private readonly verifier: TokenVerifier) {}

  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
    if (!token) {
      throw new UnauthorizedException("Missing bearer token");
    }
    let ctx;
    try {
      ctx = await this.verifier.verify(token);
    } catch {
      throw new UnauthorizedException("Invalid token");
    }
    runWithAuth(ctx, () => next());
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec jest packages/tenant-context/src/auth.middleware.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/tenant-context/src/auth.middleware.ts packages/tenant-context/src/auth.middleware.spec.ts
git rm packages/tenant-context/src/tenant.middleware.ts
git commit -m "feat(tenant-context): AuthMiddleware (Bearer-required, 401, no header fallback)"
```

---

## Task 4: @Roles decorator + RolesGuard (403)

**Files:**
- Create: `packages/tenant-context/src/roles.guard.ts`
- Create: `packages/tenant-context/src/roles.guard.spec.ts`

**Context:** The guard runs after `AuthMiddleware`, so it reads the current role via `getRole()` from the async context. If a handler has no `@Roles(...)`, the guard allows it (any authenticated caller). If it has `@Roles(...)`, the caller's role must be in the list, else `ForbiddenException` (403). Uses Nest `Reflector` to read handler + class metadata.

- [ ] **Step 1: Write the failing test**

Create `packages/tenant-context/src/roles.guard.spec.ts`:

```ts
import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Roles, RolesGuard, ROLES_KEY } from "./roles.guard";
import { runWithAuth } from "./auth-context";

function ctxFor(handler: unknown): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => class {},
  } as unknown as ExecutionContext;
}

describe("RolesGuard", () => {
  const reflector = new Reflector();
  const guard = new RolesGuard(reflector);

  it("decorator attaches role metadata", () => {
    class C {
      @Roles("merchant")
      handler(): void {}
    }
    const meta = reflector.get(ROLES_KEY, new C().handler);
    expect(meta).toEqual(["merchant"]);
  });

  it("allows a handler with no @Roles metadata", () => {
    const ok = runWithAuth({ tenantId: "berlin", role: "customer", sub: "c-1" }, () =>
      guard.canActivate(ctxFor(() => undefined)),
    );
    expect(ok).toBe(true);
  });

  it("allows a caller whose role matches", () => {
    class C {
      @Roles("merchant")
      handler(): void {}
    }
    const h = new C().handler;
    const ok = runWithAuth({ tenantId: "berlin", role: "merchant", sub: "m-1" }, () =>
      guard.canActivate(ctxFor(h)),
    );
    expect(ok).toBe(true);
  });

  it("forbids a caller whose role does not match (403)", () => {
    class C {
      @Roles("merchant")
      handler(): void {}
    }
    const h = new C().handler;
    expect(() =>
      runWithAuth({ tenantId: "berlin", role: "customer", sub: "c-1" }, () =>
        guard.canActivate(ctxFor(h)),
      ),
    ).toThrow(ForbiddenException);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec jest packages/tenant-context/src/roles.guard.spec.ts`
Expected: FAIL — cannot find module `./roles.guard`.

- [ ] **Step 3: Write the implementation**

Create `packages/tenant-context/src/roles.guard.ts`:

```ts
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { getRole } from "./auth-context";

export const ROLES_KEY = "flashbite:roles";

export const Roles = (...roles: string[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) {
      return true;
    }
    const role = getRole();
    if (!required.includes(role)) {
      throw new ForbiddenException(`Requires role: ${required.join(", ")}`);
    }
    return true;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec jest packages/tenant-context/src/roles.guard.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/tenant-context/src/roles.guard.ts packages/tenant-context/src/roles.guard.spec.ts
git commit -m "feat(tenant-context): @Roles decorator + RolesGuard (403 on mismatch)"
```

---

## Task 5: Export surface + JWKS config + test-helper subpath mapping

**Files:**
- Modify: `packages/tenant-context/src/index.ts`
- Modify: `packages/shared/src/config.ts`
- Modify: `packages/shared/src/config.spec.ts`
- Modify: `jest.config.cjs`
- Modify: `tsconfig.json`

- [ ] **Step 1: Write the failing config test**

Edit `packages/shared/src/config.spec.ts` — add a case asserting the new default. Append inside the existing `describe`:

```ts
  it("defaults jwtJwksUrl to the local identity JWKS endpoint", () => {
    const cfg = loadConfig({ DATABASE_URL: "postgres://x" });
    expect(cfg.jwtJwksUrl).toBe("http://localhost:3003/.well-known/jwks.json");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec jest packages/shared/src/config.spec.ts -t jwtJwksUrl`
Expected: FAIL — `cfg.jwtJwksUrl` is `undefined`.

- [ ] **Step 3: Add the config field**

Edit `packages/shared/src/config.ts`:

In `interface AppConfig`, add after `jwtAccessTtl: number;`:

```ts
  jwtJwksUrl: string;
```

In the `return { ... }` of `loadConfig`, add after `jwtAccessTtl: Number(env.JWT_ACCESS_TTL ?? 3600),`:

```ts
    jwtJwksUrl: env.JWT_JWKS_URL ?? "http://localhost:3003/.well-known/jwks.json",
```

- [ ] **Step 4: Update the package export surface**

Replace the contents of `packages/tenant-context/src/index.ts` with:

```ts
export * from "./auth-context";
export * from "./token-verifier";
export * from "./auth.middleware";
export * from "./roles.guard";
```

Note: `./testing` is intentionally NOT re-exported from the package entrypoint (test-only — it pulls in key generation). Specs *inside* the package import it relatively (`./testing`). App e2e specs import it via the dedicated subpath `@flashbite/tenant-context/testing`, mapped in the next step.

- [ ] **Step 5: Map the test-helper subpath in Jest + tsconfig**

The Jest config builds `moduleNameMapper` from a `paths` object that currently lists only the bare package specifiers, so a subpath import must be added explicitly.

Edit `jest.config.cjs` — add an entry to the `paths` object (place it BEFORE the bare `@flashbite/tenant-context` entry is irrelevant since both are exact-match regexes, but keep it adjacent for clarity):

```js
const paths = {
  "@flashbite/contracts": ["packages/contracts/src/index.ts"],
  "@flashbite/shared": ["packages/shared/src/index.ts"],
  "@flashbite/tenant-context": ["packages/tenant-context/src/index.ts"],
  "@flashbite/tenant-context/testing": ["packages/tenant-context/src/testing.ts"],
  "@flashbite/web-shared": ["packages/web-shared/src/index.ts"],
};
```

The same `paths` object is also passed to the inline `ts-jest` `tsconfig.paths`, so adding it here covers both module resolution and type-checking inside Jest.

Edit `tsconfig.json` — add the matching entry to `compilerOptions.paths`:

```json
      "@flashbite/tenant-context": ["packages/tenant-context/src/index.ts"],
      "@flashbite/tenant-context/testing": ["packages/tenant-context/src/testing.ts"],
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm exec jest packages/shared/src/config.spec.ts packages/tenant-context`
Expected: PASS (config + all tenant-context specs — these use relative imports, so they pass regardless of the subpath mapping; the mapping is exercised by the app e2e in Tasks 6–7).

- [ ] **Step 7: Commit**

```bash
git add packages/tenant-context/src/index.ts packages/shared/src/config.ts packages/shared/src/config.spec.ts jest.config.cjs tsconfig.json
git commit -m "feat(shared,tenant-context): add JWT_JWKS_URL config; export auth surface; map /testing helper"
```

---

## Task 6: Wire write-api (AuthMiddleware + RolesGuard + role decorators) and migrate its e2e

**Files:**
- Modify: `apps/write-api/src/app.module.ts`
- Modify: `apps/write-api/src/health.controller.ts`
- Modify: `apps/write-api/src/orders/orders.controller.ts`
- Modify: `apps/write-api/src/orders/accept.controller.ts`
- Modify: `apps/write-api/test/health.e2e-spec.ts`
- Modify: `apps/write-api/test/orders.e2e-spec.ts`
- Modify: `apps/write-api/test/accept.e2e-spec.ts`

**Prereq for e2e:** Postgres must be up (`pnpm infra:up`) — these are existing infra-backed e2e tests. The verifier is overridden with the local test fixture, so identity does NOT need to run.

- [ ] **Step 1: Wire the module**

Replace `apps/write-api/src/app.module.ts` with:

```ts
import { Module, MiddlewareConsumer, NestModule } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AuthMiddleware, RolesGuard, TokenVerifier } from "@flashbite/tenant-context";
import { HealthController } from "./health.controller";
import { OrdersModule } from "./orders/orders.module";

@Module({
  imports: [OrdersModule],
  controllers: [HealthController],
  providers: [TokenVerifier, { provide: APP_GUARD, useClass: RolesGuard }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(AuthMiddleware).exclude("health").forRoutes("*");
  }
}
```

- [ ] **Step 2: Make health unauthenticated**

Replace `apps/write-api/src/health.controller.ts` with:

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

- [ ] **Step 3: Add role decorators**

Edit `apps/write-api/src/orders/orders.controller.ts` — add the import and decorator:

```ts
import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import { Roles } from "@flashbite/tenant-context";
import { CreateOrderDto } from "./create-order.dto";
import { OrdersService } from "./orders.service";

@Controller("orders")
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  @HttpCode(201)
  @Roles("customer")
  place(@Body() dto: CreateOrderDto): Promise<{ orderId: string }> {
    return this.orders.placeOrder(dto);
  }
}
```

Edit `apps/write-api/src/orders/accept.controller.ts` — add `import { Roles } from "@flashbite/tenant-context";` (alongside the existing `getTenantId` import line, e.g. `import { getTenantId, Roles } from "@flashbite/tenant-context";`) and put `@Roles("merchant")` on both the `accept` and `decline` handlers:

```ts
  @Post(":orderId/accept")
  @HttpCode(202)
  @Roles("merchant")
  async accept(@Param("orderId") orderId: string): Promise<{ orderId: string; signalled: string }> {
    return this.signal(orderId, true);
  }

  @Post(":orderId/decline")
  @HttpCode(202)
  @Roles("merchant")
  async decline(@Param("orderId") orderId: string): Promise<{ orderId: string; signalled: string }> {
    return this.signal(orderId, false);
  }
```

- [ ] **Step 4: Migrate health e2e**

Replace `apps/write-api/test/health.e2e-spec.ts` with:

```ts
import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../src/app.module";

describe("write-api health (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /health returns ok without a token (excluded from auth)", async () => {
    const res = await request(app.getHttpServer()).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});
```

- [ ] **Step 5: Migrate orders e2e (Bearer + 401/403 cases)**

Replace `apps/write-api/test/orders.e2e-spec.ts` with:

```ts
import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { AppModule } from "../src/app.module";
import { PrismaService } from "@flashbite/shared";
import { TokenVerifier } from "@flashbite/tenant-context";
import { createTestAuth, type TestAuth } from "@flashbite/tenant-context/testing";

describe("write-api orders (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: TestAuth;
  let customer: string;

  beforeAll(async () => {
    auth = await createTestAuth();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TokenVerifier)
      .useValue(auth.verifier)
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = app.get(PrismaService);
    customer = await auth.mint({ tenantId: "berlin", role: "customer", sub: "c-1" });
  });

  afterAll(async () => {
    await app.close();
  });

  const body = (orderId: string) => ({
    orderId,
    customerId: "c-1",
    items: [{ sku: "pizza", qty: 1, price: 1200 }],
    totalAmount: 1200,
  });

  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  it("writes an event_store row and a PENDING outbox row atomically", async () => {
    const orderId = randomUUID();
    const res = await request(app.getHttpServer())
      .post("/orders")
      .set(bearer(customer))
      .send(body(orderId));

    expect(res.status).toBe(201);
    expect(res.body.orderId).toBe(orderId);

    const events = await prisma.eventStore.findMany({
      where: { tenantId: "berlin", aggregateId: orderId },
    });
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("OrderPlaced");

    const outbox = await prisma.outbox.findMany({
      where: { tenantId: "berlin", partitionKey: `berlin:${orderId}` },
    });
    expect(outbox).toHaveLength(1);
    expect(outbox[0].status).toBe("PENDING");
    expect(outbox[0].topic).toBe("order-events");
  });

  it("is idempotent — re-posting the same orderId does not duplicate", async () => {
    const orderId = randomUUID();
    await request(app.getHttpServer()).post("/orders").set(bearer(customer)).send(body(orderId));
    const res2 = await request(app.getHttpServer())
      .post("/orders")
      .set(bearer(customer))
      .send(body(orderId));

    expect(res2.status).toBe(201);
    const events = await prisma.eventStore.findMany({
      where: { tenantId: "berlin", aggregateId: orderId },
    });
    expect(events).toHaveLength(1);
    const outbox = await prisma.outbox.findMany({
      where: { tenantId: "berlin", partitionKey: `berlin:${orderId}` },
    });
    expect(outbox).toHaveLength(1);
  });

  it("rejects an invalid payload with 400", async () => {
    const res = await request(app.getHttpServer())
      .post("/orders")
      .set(bearer(customer))
      .send({ orderId: "not-much" });
    expect(res.status).toBe(400);
  });

  it("rejects a request with no token (401)", async () => {
    const res = await request(app.getHttpServer())
      .post("/orders")
      .send(body(randomUUID()));
    expect(res.status).toBe(401);
  });

  it("rejects a non-customer role (403)", async () => {
    const merchant = await auth.mint({ tenantId: "berlin", role: "merchant", sub: "m-1" });
    const res = await request(app.getHttpServer())
      .post("/orders")
      .set(bearer(merchant))
      .send(body(randomUUID()));
    expect(res.status).toBe(403);
  });

  it("derives the tenant from the token, not a header", async () => {
    const tokyo = await auth.mint({ tenantId: "tokyo", role: "customer", sub: "c-9" });
    const orderId = randomUUID();
    await request(app.getHttpServer()).post("/orders").set(bearer(tokyo)).send(body(orderId));
    const events = await prisma.eventStore.findMany({ where: { aggregateId: orderId } });
    expect(events).toHaveLength(1);
    expect(events[0].tenantId).toBe("tokyo");
  });
});
```

- [ ] **Step 6: Migrate accept e2e**

Open `apps/write-api/test/accept.e2e-spec.ts`. Apply the same bootstrap migration:
1. Add imports:
   ```ts
   import { TokenVerifier } from "@flashbite/tenant-context";
   import { createTestAuth, type TestAuth } from "@flashbite/tenant-context/testing";
   ```
2. In `beforeAll`, before building the module, add `auth = await createTestAuth();` (declare `let auth: TestAuth;` at suite scope) and chain `.overrideProvider(TokenVerifier).useValue(auth.verifier)` onto `Test.createTestingModule({ imports: [AppModule] })` before `.compile()`. Mint a merchant token: `merchant = await auth.mint({ tenantId: "berlin", role: "merchant", sub: "m-1" });` (declare `let merchant: string;`).
3. Replace every `.set("X-Tenant-ID", "berlin")` with `.set("Authorization", \`Bearer ${merchant}\`)` (accept/decline require the merchant role). If the existing test uses another tenant for any case, mint a matching merchant token for that tenant and use it.

- [ ] **Step 7: Run write-api e2e**

Run: `pnpm infra:up && pnpm exec jest apps/write-api`
Expected: PASS — health (no token), orders (201 + idempotent + 400 + 401 + 403 + tenant-from-token), accept (202 with merchant token).

- [ ] **Step 8: Commit**

```bash
git add apps/write-api/src/app.module.ts apps/write-api/src/health.controller.ts apps/write-api/src/orders/orders.controller.ts apps/write-api/src/orders/accept.controller.ts apps/write-api/test/health.e2e-spec.ts apps/write-api/test/orders.e2e-spec.ts apps/write-api/test/accept.e2e-spec.ts
git commit -m "feat(write-api): Bearer-required auth + role guards; migrate e2e from X-Tenant-ID"
```

---

## Task 7: Wire read-api (AuthMiddleware) and migrate its e2e

**Files:**
- Modify: `apps/read-api/src/app.module.ts`
- Modify: `apps/read-api/src/health.controller.ts`
- Modify (Bearer migration): `apps/read-api/test/health.e2e-spec.ts`, `orders-query.e2e-spec.ts`, `drivers-nearby.e2e-spec.ts`, `telemetry-ingest.e2e-spec.ts`, `merchant-orders.e2e-spec.ts`, `sse.e2e-spec.ts`, `orders-cache.e2e-spec.ts`

**Context:** read-api has no role-restricted endpoints in S1 (reads + telemetry ingest require a valid token but no specific role), so the `RolesGuard` is not needed here — only `AuthMiddleware` + `TokenVerifier`. Pure-unit specs that never start the HTTP app and never send `X-Tenant-ID` (`order-stream.spec.ts`, `sse-feeder.spec.ts`) are left unchanged.

- [ ] **Step 1: Wire the module**

Replace `apps/read-api/src/app.module.ts` with:

```ts
import { Module, MiddlewareConsumer, NestModule } from "@nestjs/common";
import { AuthMiddleware, TokenVerifier } from "@flashbite/tenant-context";
import { HealthController } from "./health.controller";
import { OrdersModule } from "./orders/orders.module";
import { SseModule } from "./sse/sse.module";
import { DriversModule } from "./drivers/drivers.module";

@Module({
  imports: [OrdersModule, SseModule, DriversModule],
  controllers: [HealthController],
  providers: [TokenVerifier],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(AuthMiddleware).exclude("health").forRoutes("*");
  }
}
```

- [ ] **Step 2: Make health unauthenticated**

Replace `apps/read-api/src/health.controller.ts` with:

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

- [ ] **Step 3: Migrate health e2e**

Replace `apps/read-api/test/health.e2e-spec.ts` with:

```ts
import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../src/app.module";

describe("read-api health (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /health returns ok without a token (excluded from auth)", async () => {
    const res = await request(app.getHttpServer()).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});
```

- [ ] **Step 4: Migrate the HTTP e2e specs to Bearer (mechanical, identical pattern)**

For EACH of `orders-query.e2e-spec.ts`, `drivers-nearby.e2e-spec.ts`, `telemetry-ingest.e2e-spec.ts`, `merchant-orders.e2e-spec.ts`, `sse.e2e-spec.ts`, `orders-cache.e2e-spec.ts`:

1. Add imports near the top:
   ```ts
   import { TokenVerifier } from "@flashbite/tenant-context";
   import { createTestAuth, type TestAuth } from "@flashbite/tenant-context/testing";
   ```
2. Add a suite-scoped `let auth: TestAuth;` and per-tenant token vars as needed: `let berlinToken: string;` (and `let tokyoToken: string;` for any spec that exercises a second tenant — `orders-query`, `drivers-nearby`, and `telemetry-ingest` all have a tokyo-isolation case).
3. In `beforeAll`, before constructing the module, add:
   ```ts
   auth = await createTestAuth();
   ```
   and chain the override onto the existing `Test.createTestingModule({ imports: [AppModule] })` call, immediately before `.compile()`:
   ```ts
   .overrideProvider(TokenVerifier)
   .useValue(auth.verifier)
   ```
   After `app.init()`, mint the tokens used by the spec. Use the role appropriate to the surface: `merchant` for `merchant-orders.e2e-spec.ts` and `sse.e2e-spec.ts` (the merchant SSE/orders feed); `customer` for `orders-query.e2e-spec.ts` and `orders-cache.e2e-spec.ts`; `driver` for `telemetry-ingest.e2e-spec.ts`; for `drivers-nearby.e2e-spec.ts` use `customer` (nearby is an open read). Example:
   ```ts
   berlinToken = await auth.mint({ tenantId: "berlin", role: "customer", sub: "c-1" });
   tokyoToken = await auth.mint({ tenantId: "tokyo", role: "customer", sub: "c-9" });
   ```
4. Replace every `.set("X-Tenant-ID", "berlin")` with `.set("Authorization", \`Bearer ${berlinToken}\`)` and every `.set("X-Tenant-ID", "tokyo")` with `.set("Authorization", \`Bearer ${tokyoToken}\`)`. The tenant is now carried by the token; the assertions (which check tenant-scoped data + cross-tenant isolation) are unchanged and still hold because the token's `tenantId` matches what the header used to assert.

- [ ] **Step 5: Add a 401 case to one read spec**

In `apps/read-api/test/orders-query.e2e-spec.ts`, add a test asserting the hard cut:

```ts
  it("rejects a query with no token (401)", async () => {
    const res = await request(app.getHttpServer()).get("/orders/" + "00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(401);
  });
```

- [ ] **Step 6: Run read-api e2e**

Run: `pnpm infra:up && pnpm exec jest apps/read-api`
Expected: PASS — health (no token), all migrated specs green with Bearer, the new 401 case green. (Unit specs `order-stream.spec.ts`/`sse-feeder.spec.ts` unaffected.)

- [ ] **Step 7: Commit**

```bash
git add apps/read-api/src/app.module.ts apps/read-api/src/health.controller.ts apps/read-api/test/
git commit -m "feat(read-api): Bearer-required auth; migrate e2e from X-Tenant-ID"
```

---

## Task 8: Migrate requests.http + full verification

**Files:**
- Modify: `apps/write-api/requests.http`

- [ ] **Step 1: Migrate requests.http to Bearer**

In `apps/write-api/requests.http`, the Identity section already defines a `# @name login` request that captures `{{login.response.body.$.accessToken}}`. For every write-api (`{{baseUrl}}`) and read-api (`{{readUrl}}`) request that currently sends `X-Tenant-ID: {{tenant}}` or `X-Tenant-ID: tokyo`:
1. Remove the `X-Tenant-ID: ...` line.
2. Add `Authorization: Bearer {{login.response.body.$.accessToken}}` in its place.

Add a comment near the top of the write-api section noting the new flow:

```
# Phase 2 (S1): tenant + role come from the verified JWT. Run the `login` request
# (Identity section above) first to populate {{login.response.body.$.accessToken}};
# every command/query below sends it as `Authorization: Bearer`. The old
# `X-Tenant-ID` header is no longer accepted. To exercise tokyo or a different role,
# log in as that user (e.g. customer@tokyo.test / merchant@berlin.test) and re-run.
```

For the requests that previously targeted `tokyo` (the "Different tenant (tokyo)" order and the tokyo isolation reads), add a second named login (e.g. `# @name loginTokyo` posting `customer@tokyo.test`) and reference `{{loginTokyo.response.body.$.accessToken}}` on those specific requests, so the file still demonstrates cross-tenant behaviour without a trusted header. Keep the `@tenant` variable definition removed or unused.

- [ ] **Step 2: Typecheck, lint, build (per project convention — run before declaring done)**

Run: `pnpm -r exec tsc --noEmit` (or the repo's typecheck script if present, e.g. `pnpm -r build`)
Expected: no type errors. Resolve any deep-import type resolution for `@flashbite/tenant-context/testing` (it resolves via the workspace TS path mapping; if the build complains, confirm the import path matches the package layout).

- [ ] **Step 3: Run the full backend test suite**

Run: `pnpm infra:up && pnpm test`
Expected: PASS — tenant-context unit specs, shared config spec, write-api e2e, read-api e2e, and the rest of the existing backend suite. The identity service tests are unaffected.

- [ ] **Step 4: Commit**

```bash
git add apps/write-api/requests.http
git commit -m "docs(write-api): migrate requests.http from X-Tenant-ID to Bearer (Phase 2 S1)"
```

---

## Self-review notes (coverage check)

- **Verified-JWT tenant/role resolution** → Tasks 1–3 (auth context, verifier, middleware).
- **Bearer-required hard cut, no header fallback, 401** → Task 3 + e2e 401 cases (Tasks 6, 7).
- **`/health` excluded from auth** → Tasks 6, 7 (`.exclude("health")` + health controllers drop `tenantId`).
- **`getTenantId()` preserved + `getRole()`/`getAuthContext()` added** → Task 1.
- **`@Roles` 403 on `POST /orders`=customer, accept/decline=merchant** → Tasks 4, 6.
- **`JWT_JWKS_URL` config** → Task 5.
- **requests.http + backend e2e migrated to Bearer** → Tasks 6, 7, 8.
- **Out of scope (S2/S3/S4):** no RLS, no operator API, no frontend/gps-script/Playwright changes — the frontends will be non-functional until S4, as the spec states.

## Notes for the executor

- Run `pnpm infra:up` before the e2e tasks (existing tests hit Postgres/Mongo/Redis).
- The test fixture (`createTestAuth`) means **the identity service does not need to run** for backend tests — tokens are minted from a local keypair and verified against a local JWKS injected via `overrideProvider(TokenVerifier)`.
- Nest middleware establishes the AsyncLocalStorage scope via `runWithAuth(ctx, () => next())`; guards and services downstream read it — this is the same mechanism the old `TenantMiddleware` used, so no ordering surprises.
- Keep commits atomic per task (the commands above).
