# FlashBite Phase 2a — Identity Service + JWT (Design Spec)

**Date:** 2026-06-15
**Status:** Approved (pending spec review)
**Phase:** First slice of Phase 2 (identity + multi-tenant isolation "hard mode").

## Phase 2 context (slice map)

Phase 2 replaces the **trusted `X-Tenant-ID` header** with **verified-JWT identity**, derives the
tenant (and role) from the token everywhere, and enforces Postgres Row-Level Security. It is built
in slices:

| Slice | Deliverable | Status |
|------|-------------|--------|
| **2a (this)** | Identity service: issue RS256 JWTs + JWKS, seeded users | this spec |
| 2b | Verify-JWT tenant/role context in write-api + read-api (replaces `TenantMiddleware`) | later |
| 2c | Postgres RLS on the event-store tables (per-request session var + non-superuser role; poller bypass) | later (parallel with 2b) |
| 2d | Frontend login + session; `Authorization: Bearer` replaces `X-Tenant-ID`; e2e migrated | later |

This slice (2a) is the **foundation**: it stands alone — you can log in and get a verifiable JWT —
without changing how any existing service resolves tenancy yet.

## Goal

A dedicated `apps/identity` service that authenticates seeded users and issues short-lived,
**RS256-signed** access tokens, and publishes its public keys at a **JWKS** endpoint so other
services can verify tokens **without sharing a signing secret** ("isolation rests on cryptographic
identity, not trust"). No service consumes these tokens yet — that is slice 2b.

## Scope

**In:** a new NestJS `apps/identity` service (dev port **3003**); a Prisma `User` model + migration
in the existing Postgres; argon2id password hashing; `POST /auth/login` issuing an RS256 JWT;
`GET /.well-known/jwks.json`; `GET /health`; a startup-generated RS256 keypair (in-memory, served
via JWKS); a seed of demo users per tenant per role; config additions; root `dev:identity` script.

**Out (later slices / backlog):** verifying tokens in write-api/read-api (2b); Postgres RLS (2c);
login UI + browser session + replacing `X-Tenant-ID` (2d); **refresh tokens / rotation** (backlog);
signup / user-management / password reset; **key persistence + rotation** across restarts
(backlog); revocation/blocklist.

## Architecture

- **`apps/identity`** — Next NestJS service mirroring the existing apps (`main.ts` bootstrap,
  `AppModule`, `health.controller`, a `ValidationPipe`). Stateless: it authenticates and mints
  tokens; it holds no sessions. Dev on **3003** (web-admin owns 3103; 3003 is free in the API
  band 3001/3002).
- **Signing** — uses **`jose`**. On boot the service generates one **RS256** keypair in memory,
  assigns it a `kid`, and keeps the private key for signing + the public key for JWKS. Tokens do
  not survive a restart (a new `kid` is generated); verifiers (2b) re-fetch JWKS on an unknown
  `kid`. Production would persist/rotate keys via a secret store — noted in the backlog.
- **Passwords** — **argon2id** (`argon2` package). Seeded users store an argon2id hash; login
  verifies with a constant-time compare.
- **Persistence** — the existing Postgres via the shared Prisma client; a new `User` model. No
  other store is touched.

## Data model

New Prisma model in `packages/shared/prisma/schema.prisma`:

```
model User {
  id           String   @id @default(uuid())
  tenantId     String
  email        String
  passwordHash String
  role         String   // customer | merchant | driver | admin
  createdAt    DateTime @default(now())

  @@unique([tenantId, email])
  @@index([tenantId])
}
```

A migration creates the table. A **seed** inserts demo users (idempotent upsert): for each tenant
in `{ berlin, tokyo }` and each role in `{ customer, merchant, driver, admin }`, an account
`role@tenant.test` (e.g. `merchant@berlin.test`) with a single shared dev password (documented in
`.env.example`, never a real secret). Roles are the four claim values used from 2b onward.

## Endpoints

- **`POST /auth/login`** — body `{ email, password }`. Looks up the user by email; verifies the
  argon2id hash. On success, signs an RS256 JWT with claims `{ sub: user.id, tenantId, role, iss,
  aud, exp }` (header carries `alg: RS256`, `kid`), and returns
  `{ accessToken, tokenType: "Bearer", expiresIn }` (`expiresIn` = `JWT_ACCESS_TTL`, default 3600s).
- **`GET /.well-known/jwks.json`** — returns `{ keys: [ <public JWK> ] }` (the public key as a JWK
  with `kid`, `kty: "RSA"`, `alg: "RS256"`, `use: "sig"`, `n`, `e`). This is what 2b's verifier
  consumes.
- **`GET /health`** — `{ status: "ok" }` (mirrors the other services).

No `tenantId` is taken from the request — the tenant is whatever the authenticated user belongs to
(read from the `User` row). This is the core inversion vs Phase 1's trusted header.

## Config

Add to `loadConfig` / env (`.env`, `.env.example`):

- `JWT_ISSUER` (e.g. `flashbite-identity`)
- `JWT_AUDIENCE` (e.g. `flashbite`)
- `JWT_ACCESS_TTL` (seconds, default `3600`)
- `IDENTITY_PORT` (default `3003`) — or a fixed port in `main.ts` consistent with the other apps
- `SEED_USER_PASSWORD` (dev-only; used by the seed; documented in `.env.example`)

New dependencies: `jose`, `argon2`. Root script `dev:identity` mirroring the other `dev:*` scripts.

## Data flow

```
seed (once)         apps/identity (:3003)                 verifier (slice 2b, later)
  └─ User rows ─────►  POST /auth/login                    GET /.well-known/jwks.json
                         ├─ argon2id verify                       ▲
                         └─ sign RS256 (kid) ──► accessToken      │ (public key, by kid)
                       GET /.well-known/jwks.json ────────────────┘
```

## Error handling

- **Bad credentials** (no such email, or wrong password) → **401** with a single generic message
  (`Invalid email or password`) — no user enumeration; both paths take the argon2 verify cost where
  practical.
- **Malformed body** → 400 via `ValidationPipe` (whitelist + transform), like the other services.
- The private key lives only in memory in the identity process; it is never logged or returned.

## Testing

- **e2e (`apps/identity`, Jest, boots Nest + Postgres):**
  - a seeded user logs in → `200`, and the returned `accessToken` **verifies against the served
    JWKS** with the expected claims (`sub` set, `tenantId`/`role` match the seeded user, `iss`/`aud`
    match config, `exp` in the future).
  - wrong password → `401`; unknown email → `401` (same message).
  - `GET /.well-known/jwks.json` returns a key whose `kid` matches the token header and that
    verifies the token.
- **Unit:** the claim-builder produces the documented claim set + TTL; argon2id hash/verify
  round-trips; login maps unknown-user and bad-password to the same 401.
- Tests run under the root Jest (backend), consistent with the other services.

## Open assumptions

- Two tenants (`berlin`, `tokyo`) × four roles, seeded; no self-signup in Phase 2.
- Access-token-only (~1h); refresh tokens are backlogged.
- RS256 keypair is **generated at startup, in memory** — tokens are invalidated on identity
  restart; key persistence/rotation is backlogged.
- Identity reads the existing Postgres (new `User` table); no RLS yet (2c), so identity itself runs
  as the current privileged Prisma user.
- This slice changes **nothing** about how write-api/read-api/workers/frontends resolve tenancy —
  they still use `X-Tenant-ID` until slice 2b/2d.
