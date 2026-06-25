# Identity hardening — access + refresh tokens (design)

**Goal:** Harden FlashBite identity by splitting the single long-lived JWT into a **short-lived access token (AT)** plus a **server-tracked, rotating refresh token (RT)**, and by **persisting the signing key with controlled rotation** — so a leaked token has a small blast radius, sessions can be revoked, token theft is detectable, and an identity restart no longer silently invalidates every session.

**Builds on:** Phase 2 identity (`apps/identity` :3003 — argon2 login, `jose` RS256 JWT `{sub, tenantId, role}`, JWKS at `/.well-known/jwks.json`), the `@flashbite/tenant-context` `TokenVerifier`/`AuthMiddleware`/ALS `AuthContext`, and the `@flashbite/web-shared` `auth-store` + `authedFetch` (Bearer header, hard logout on 401). Branch `phase-identity-at-rt-hardening` off `main`.

## Scope

In scope: short AT + stateful rotating RT (issue/refresh/rotate/reuse-detect/revoke); RT delivered as an httpOnly cookie; persisted signing key with current+previous JWKS and a deliberate rotation operation; client transparent refresh-on-401 with single-flight; tests + docs.

Out of scope (backlog, noted): KMS / encryption-at-rest for the signing private key; "revoke all sessions for a user" (e.g. on password change); proactive refresh for SSE streams; session-listing UI; the separate multi-tenancy "tenant catalog" enhancement (assessed against the Atlassian TCS article — see Appendix).

## Token lifecycle

```
POST /auth/login   (email+password)
   -> argon2 verify
   -> AT  = RS256 JWT {sub,tenantId,role}, exp = JWT_ACCESS_TTL (900s)   -> JSON body { accessToken, tokenType, expiresIn }
   -> RT  = random 256-bit opaque token, exp = JWT_REFRESH_TTL (~30d)
        store sha-256(RT) row (familyId, userId, tenantId, status=active)
        Set-Cookie: fb_rt=<raw>; HttpOnly; Secure*; SameSite=Strict; Path=<RT_COOKIE_PATH>; Max-Age=REFRESH_TTL
        (* Secure omitted in dev/http via RT_COOKIE_SECURE=false)

POST /auth/refresh (cookie fb_rt only, no body)
   -> lookup row by sha-256(cookie)
        active & not expired -> ROTATE: old.status=rotated; insert new RT row (same familyId); new Set-Cookie; return fresh AT
        rotated|revoked      -> REUSE DETECTED: revoke entire familyId; 401; clear cookie
        expired|unknown      -> 401; clear cookie

POST /auth/logout  (cookie fb_rt only)
   -> presented row.status=revoked; clear cookie; 204
```

- **AT** stays an RS256 JWT verified statelessly by resource servers — unchanged claim shape `{sub, tenantId, role, iss, aud, iat, exp}`. Only the TTL changes (3600 → 900).
- **RT** is opaque and **server-tracked**; the raw value is never stored (only `sha-256`). Rotation is **one-time-use**: each refresh invalidates the presented RT and issues a successor in the same `familyId`. Presenting an already-rotated/revoked RT is the token-theft signature → the whole family is revoked.
- Multiple concurrent sessions/devices are supported naturally (one family per login).

## Data model

Two new models in `packages/shared/prisma/schema.prisma` (+ one migration).

```prisma
model RefreshToken {
  id         String    @id @default(uuid())
  familyId   String    @map("family_id")
  userId     String    @map("user_id")
  tenantId   String    @map("tenant_id")
  tokenHash  String    @unique @map("token_hash")  // sha-256 hex; raw never stored
  status     String    @default("active")          // active | rotated | revoked
  expiresAt  DateTime  @map("expires_at")
  createdAt  DateTime  @default(now()) @map("created_at")
  rotatedAt  DateTime? @map("rotated_at")
  revokedAt  DateTime? @map("revoked_at")
  @@index([familyId])
  @@index([userId])
  @@map("refresh_tokens")
}

model SigningKey {
  kid        String   @id                  // JWK thumbprint
  alg        String   @default("RS256")
  privateJwk String   @map("private_jwk")  // JWK JSON
  publicJwk  String   @map("public_jwk")   // JWK JSON
  status     String   @default("current")  // current | previous | retired
  createdAt  DateTime @default(now()) @map("created_at")
  @@map("signing_keys")
}
```

- Neither table is under RLS — consistent with `users` (identity owns them; every query is scoped by `userId`/`kid`). `tenantId` on `refresh_tokens` is carried for audit only.
- Expired/retired RT rows are pruned by a cheap `deleteMany({ expiresAt < now })` on the refresh path (no scheduler).
- `signing_keys`: at most one `current`; JWKS publishes `status IN (current, previous)`.

## Component changes

**`apps/identity`**
- **`KeyService`** — on boot, load the `current` `SigningKey` (generate + persist if none, replacing today's ephemeral `onModuleInit` generation). Expose: the current signing key (private) for `TokenService`; the public JWKS set (`current`+`previous`) for `JwksController`; `rotate()` (new key → `current`, old `current` → `previous`, old `previous` → `retired`).
- **`TokenService`** — sign the AT with the current key at `JWT_ACCESS_TTL` (900s). Unchanged claim shape.
- **`RefreshTokenService` (new)** — `issue(userId, tenantId): { raw, expiresAt }`; `rotate(raw): { raw, accessSubject } | reuse | invalid`; `revoke(raw)`; plus the expired-row prune. Hashing via `node:crypto` `createHash("sha256")`. Family revocation = `updateMany({ familyId }, { status: "revoked", revokedAt })`.
- **`AuthService`** — `login` also issues an RT; new `refresh` and `logout`.
- **`AuthController`** — `POST /auth/login` (sets RT cookie + returns AT body, shape unchanged), `POST /auth/refresh` (cookie-only), `POST /auth/logout` (cookie-only). A small cookie helper reads the `Cookie` request header and writes `Set-Cookie` (no new dependency).
- **`JwksController`** — serve `KeyService`'s multi-key set.
- **config (`packages/shared/src/config.ts`)** — `JWT_ACCESS_TTL` default 3600 → **900**; new `JWT_REFRESH_TTL` (default 2592000), `RT_COOKIE_NAME` (default `fb_rt`), `RT_COOKIE_SECURE` (default false in dev), `RT_COOKIE_PATH` (default `/api/identity/auth`). **Cookie-path gotcha:** identity sits behind each app's Next rewrite (`/api/identity/*` → `:3003/auth/*`), so the browser-visible path is `/api/identity/auth/...` even though identity sees `/auth/...`. The cookie `Path` MUST be the browser-facing path or the browser never returns it to `/api/identity/auth/refresh` — hence `RT_COOKIE_PATH` defaults to `/api/identity/auth` (not `/auth`). Non-browser clients (`stream-gps.sh`, `requests.http`) hit identity directly and use the AT body, so the cookie path is irrelevant to them.

**`packages/shared`** — the two Prisma models + migration; the new config fields.

**`packages/web-shared`**
- **`api/client.ts`** — `authedFetch` no longer hard-logs-out on 401; it calls `refreshSession()` **once** behind a module-level single-flight promise (concurrent 401s share the one refresh), then retries the original request with the new AT. Refresh failure → `logout()` → `UnauthorizedError`. The retried request 401-ing again does **not** re-refresh (at most one refresh per original call). New `refreshSession()` (POST `/api/identity/auth/refresh`, `credentials:"include"`, stores the new AT) and server `logout()` (POST `/api/identity/auth/logout`, `credentials:"include"`). `login()` stores only the AT.
- **`store/auth-store.ts`** — unchanged AT+claims storage; `setToken` reused by the refresh path; `logout` also calls the server logout endpoint (best-effort).

**Resource servers (`read-api`, `write-api`) — no change.** `TokenVerifier`'s `createRemoteJWKSet` already resolves multiple `kid`s; a shorter AT TTL is transparent.

**The 4 Next frontends** — `/api/identity/*` rewrites already forward cookies (same-origin proxy); the only change is `credentials:"include"` on the auth fetches (login/refresh/logout).

**Scripts/docs** — `stream-gps.sh` and `requests.http` keep working (AT still in the login body); add `/auth/refresh` + `/auth/logout` examples to `requests.http`; new env vars in `.env.example`; update `ARCHITECTURE.md` + `README.md`.

## Error handling

- **Refresh with no/invalid/expired cookie** → 401 + clear `fb_rt`. Client treats as failed refresh → `logout()` → login screen.
- **Reuse of a rotated/revoked RT** → revoke the whole `familyId`, 401. Any sibling session in the family is also killed (intentional theft response).
- **Concurrent 401s** → single-flight guard ⇒ exactly one `/auth/refresh`; others await and retry with the new AT.
- **Refresh OK but retried request still 401/403** → do not loop; surface error / logout. At most one refresh per original request.
- **Identity restart (key persisted)** → old ATs still verify (same `kid`); no mass logout. **Deliberate rotation** → previous key stays in JWKS until in-flight ATs expire.
- **AT just expired mid-request / clock skew** → ordinary 401 → refresh path handles it.
- **SSE streams** (`fetchEventSource`) — keep today's behavior (401 on `onopen` → `logout()`); "proactive SSE refresh" is a backlog note, not built here.

## Testing

- **identity (Jest, live DB):** login issues AT + sets RT cookie + persists a hashed `active` row; refresh rotates (old `rotated`, new row same `familyId`, new cookie, fresh AT); **reuse of a rotated RT revokes the whole family**; logout revokes the row + clears cookie; expired RT → 401; **key persistence** (a second `KeyService` init reuses the stored key — same `kid`); JWKS exposes `current`+`previous`; `rotate()` moves statuses correctly.
- **web-shared (Vitest):** `authedFetch` refreshes once on 401 then retries with the new AT; **single-flight** (N concurrent 401s ⇒ 1 refresh call); refresh failure → `logout()`; no infinite loop when the retry also 401s; `login()` stores only the AT.
- **Playwright (infra-gated):** with a short AT TTL, a logged-in session keeps working past AT expiry (silent refresh) and `logout` ends it.
- **Regression:** existing auth e2e (Bearer-required 401, RolesGuard 403) and `stream-gps.sh` login still pass — AT body shape unchanged.

## Success criteria

1. Access tokens are short-lived (~15 min); a logged-in user’s session survives AT expiry via a silent refresh, with no re-login.
2. Refresh tokens are server-tracked, one-time-use (rotating), delivered only as an httpOnly cookie, and never stored raw.
3. Reusing a rotated/revoked refresh token revokes the whole family; logout revokes the session.
4. The signing key persists across identity restarts (no accidental mass logout); JWKS serves current+previous so a deliberate rotation is non-disruptive.
5. Resource servers and `stream-gps.sh` are unaffected; identity Jest, web-shared Vitest, typechecks, and frontend builds pass; Playwright is infra-gated.

## Known simplifications (backlog)

- Signing private key stored as plaintext JWK in Postgres — real systems use a KMS / encryption-at-rest.
- No "revoke all sessions for a user" (e.g. on password change) and no session-listing UI.
- No proactive refresh for long-lived SSE connections.
- Key rotation is a manual/scripted operation, not scheduled.

## Appendix — Atlassian "Single-tenant → Multi-tenant (TCS)" article assessment

The article describes scaling a **DB-per-tenant** legacy system to **millions of tenants across regions**. Mapping to FlashBite (2 tenants, shared Postgres + RLS, single region):

| Atlassian pattern | FlashBite today | Verdict |
|---|---|---|
| Stateless compute, any node serves any tenant | Already true (tenant per-request from JWT) | Already have it |
| `TenantContext` propagated per request | ALS `AuthContext` (`tenantId/role/sub`) | Already have it (their pattern) |
| **Tenant Context Service** (catalog: tenant → DB/config) | Hardcoded `TENANTS = ["berlin","tokyo"]` | Only genuinely applicable idea — a DB-backed tenant catalog/registry (separate future slice) |
| CQRS read/write split for the catalog, DynamoDB SoT, Kinesis cross-region, SNS cache-invalidation, DB-per-tenant | n/a at this scale | YAGNI for this showcase |

Conclusion: no multi-tenancy change is bundled into this identity slice. The single defensible future enhancement is a **tenant catalog** (a `Tenant` table + cached lookup feeding the ALS context and admin fan-out), tracked as a separate spec; the rest of the TCS machinery is over-engineering for a 2-tenant demo and is documented as "if we scaled, here's what we'd add."
