# FlashBite

A multi-tenant, hyper-local delivery platform built as a **distributed-systems
architecture showcase** — one order journey taken end-to-end through every serious
backend pattern, with a second tenant present purely to prove isolation.

> Portfolio / learning project. The value is depth: each pattern is built in
> "hard mode," and the whole thing runs locally end-to-end.

---

## What it demonstrates

A single order flows through **every box** in the architecture (CQRS: an event-sourced write
plane and a projected read plane, joined by Kafka):

```mermaid
flowchart LR
  FE["Frontends :3100-3103<br/>customer / merchant / driver / admin"]
  ID["identity :3003<br/>RS256 JWT + JWKS"]
  W["write-api :3001"]
  R["read-api :3002"]
  PG[("Postgres<br/>event store + outbox<br/>+ RLS")]
  OB["outbox-poller"]
  KF["Redpanda - Kafka"]
  PJ["projection-worker"]
  SG["saga-worker - Temporal"]
  MG[("MongoDB read model")]
  RS[("Redis Cluster<br/>cache + geo")]

  FE -->|"login"| ID
  FE -->|"Bearer: place / accept"| W
  FE -->|"Bearer: query + SSE"| R
  W -.->|"verify via JWKS"| ID
  R -.->|"verify via JWKS"| ID
  W --> PG --> OB --> KF
  KF --> PJ --> MG
  KF --> SG
  SG -->|"append accept / cancel"| PG
  W -->|"merchant signal"| SG
  R --> MG
  R --> RS
```

Plus a real-time **telemetry plane** (ephemeral — Redis geo only, never persisted):

```mermaid
flowchart LR
  GPS["driver GPS pings<br/>scripts/stream-gps.sh"]
  R["read-api :3002"]
  KF["Kafka telemetry-streams"]
  TM["telemetry-worker"]
  RS[("Redis Cluster geo")]
  Q["web-driver / web-admin"]

  GPS -->|"POST /drivers/:id/location"| R
  R --> KF --> TM
  TM -->|"GEOADD tenant:{id}:drivers:geo"| RS
  Q -->|"GET /drivers/nearby"| R
  R -->|"GEOSEARCH per-tenant"| RS
```

> **Full architecture (components, sequence diagrams, data model):**
> [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

**Built (Phase 0 + 1 + 2 + 3a):**

- **CQRS + Event Sourcing + Transactional Outbox** — order events + outbox row committed in one
  Postgres transaction (Prisma); forward-only, rebuildable Mongo projections.
- **Order aggregate + ES hard mode (Phase 3a)** — `POST /orders` rehydrates the `Order` aggregate
  from its event stream, enforces transition invariants, and writes with optimistic concurrency
  (version check), replacing the prior blind-append approach. `pnpm rebuild:projection` replays
  the full event store into the Mongo read model (ES rebuildability demonstrated end-to-end).
- **Kafka (via Redpanda) — Confluent-Avro (Phase 3b)** — messages carry **Avro-encoded payloads**
  (value) with envelope metadata (eventId, tenantId, eventType, …) in **Kafka headers**. Schemas
  are governed by the **Schema Registry** at `localhost:18081`, registered via `pnpm
  register:schemas` (BACKWARD compatibility enforced; producers are lookup-only, never auto-
  register). Per-order partition keys (`tenantId:orderId`) preserve ordering.
- **Temporal sagas** — one workflow per order: charge → per-tenant SLA timer raced against the
  merchant-approval signal → accept, or compensate (refund + cancellation with a reason). Payment
  is a fake activity for now.
- **Polyglot persistence** — Postgres (event store), Mongo (read models + inbox), Redis Cluster
  (cache + geo, `tenant:{id}` hash-tag co-location).
- **Real-time telemetry** — ephemeral driver GPS (`DriverTelemetryStreamed` on `telemetry-streams`)
  into per-tenant Redis geo indices, served via `GEOSEARCH` (`GET /drivers/nearby`); never
  persisted.
- **Idempotency & dedup** — at every hop: stable `eventId`, Mongo inbox pattern, Temporal
  `WorkflowId = tenantId:orderId` reject-duplicate reuse policy.
- **Identity & verified-JWT tenancy (Phase 2)** — a dedicated `identity` service issues **RS256**
  access tokens and publishes a **JWKS** endpoint; write-api/read-api verify the token (signature +
  `iss`/`aud`/`exp`) and derive `tenantId` + `role` from it. The trusted `X-Tenant-ID` header is
  **gone** — isolation rests on cryptographic identity, not a client-supplied header.
- **Postgres Row-Level Security (Phase 2)** — the write plane (`event_store` + `outbox`) is RLS-
  enforced: write-api + saga-worker connect as a restricted, non-superuser `flashbite_app` role and
  set `app.tenant_id` per transaction, so a tenant can never read or write another's rows even if
  app code has a bug. The outbox-poller stays privileged (it relays every tenant).
- **Role-based access + operator console (Phase 2)** — JWT `role` claim (`customer` / `merchant` /
  `driver` / `admin` / `operator`) gated by a `@Roles` guard; an authenticated **cross-tenant
  operator API** (`/admin/orders`, `/admin/drivers`, merged `/admin/orders/stream`) powers the admin
  dashboard.
- **Four Next.js frontends** — customer, merchant (live SSE), driver (Mapbox), admin (operator
  console), on a shared design system, with a minimal login (seeded users) sending `Authorization:
  Bearer`.
- **Multi-tenancy** — `tenantId` threaded through every tier (Kafka keys, Mongo ids, Redis hash
  tags) and now **resolved from the verified JWT**, backstopped by Postgres RLS on the write plane.

**Planned (later phases):** a real payment provider and **driver dispatch** (closing the
order↔driver loop). Identity hardening (refresh tokens, key rotation) is backlogged. See
`docs/superpowers/backlog.md`.

See the **current architecture** in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), and the original
vision in
[`docs/superpowers/specs/2026-06-13-flashbite-showcase-design.md`](docs/superpowers/specs/2026-06-13-flashbite-showcase-design.md).

---

## Tech stack

NestJS · Next.js 16 · Kafka (Redpanda) · Confluent Schema Registry · Avro · Temporal · PostgreSQL +
Prisma (+ Row-Level Security) · MongoDB · Redis Cluster · `jose` (RS256 JWT / JWKS) · argon2 ·
recharts · react-map-gl · TypeScript · pnpm monorepo · Docker Compose.

## Monorepo layout

```
apps/        identity (JWT/JWKS), write-api, read-api, outbox-poller, projection-worker,
             saga-worker, telemetry-worker, web-customer, web-merchant, web-driver, web-admin
packages/    contracts (event types + envelope/key helpers + ROLES/TENANTS + .avsc schemas),
             messaging (Avro serde + Schema Registry client + header/publish/consume helpers
             + register script), shared (Prisma, Mongo, Redis, event-store, tenant-scoped tx),
             tenant-context (verify-JWT auth context + @Roles guard), web-shared (design system
             + client + auth store)
infra/       docker-compose.yml + runbook
spikes/      Phase 0 de-risking scripts (throwaway)
docs/        ARCHITECTURE.md, specs, per-phase plans, backlog
```

---

## Roadmap

The master spec decomposes the build into phases, each its own plan → implement cycle:

| Phase | Goal | Status |
|-------|------|--------|
| **0** | Infra up + de-risk Kafka / Temporal / outbox / Redis Cluster | ✅ complete |
| **1** | Walking skeleton end-to-end (CQRS/ES/outbox, projection, SSE, Temporal saga, telemetry) **+ all four frontends** | ✅ complete |
| **2** | Identity (verified JWT) + isolation hard mode (Postgres RLS) + operator console + frontend auth | ✅ complete |
| **3a** | Event-sourced Order aggregate (full ES, optimistic concurrency) | ✅ complete |
| **3b** | Avro + Schema Registry on the event bus | ✅ complete |
| 3 (remaining) | Real payments, driver dispatch | planned |
| 4 | Frontend polish + observability story | planned |

Phase 1 was built in vertical slices: **1a** write path (event store + outbox), **1b** read path
(projection + Redis cache + SSE), **1c-i** Temporal order-lifecycle saga, **1c-ii** driver
telemetry (Redis geo + nearby), and **1d** the frontends — **1d-i** customer storefront,
**1d-ii** merchant dashboard, **1d-iii** driver view, **1d-iv** cross-tenant admin grid.

Phase 2 was built in slices: **2a** identity service (RS256 JWT + JWKS, seeded users), **S1**
verified-JWT tenant/role context replacing `X-Tenant-ID` on write-api + read-api (Bearer-required
hard cut), **S2** Postgres RLS on the write plane, **S3** the cross-tenant operator console API, and
**S4** frontend login (Bearer everywhere, admin via the operator endpoints).

---

## Quickstart (Phase 0)

Requires Docker Desktop and pnpm.

```bash
pnpm install
pnpm infra:up          # Postgres, Mongo, Redpanda (+Console), Temporal, Redis Cluster
pnpm infra:ps          # confirm health
```

Run the de-risking spikes (proof each technology works in isolation):

```bash
pnpm --filter @flashbite/spikes kafka            # partition-key ordering
pnpm --filter @flashbite/spikes temporal:worker  # (terminal 1) leave running
pnpm --filter @flashbite/spikes temporal:run     # (terminal 2) SLA race
pnpm --filter @flashbite/spikes outbox           # outbox round-trip
pnpm --filter @flashbite/spikes redis            # cluster + tenant hash tags
```

Observability UIs: Temporal at <http://localhost:8080>, Redpanda Console at
<http://localhost:8085>. Full runbook: [`infra/README.md`](infra/README.md).

> **macOS note:** Redis runs as a single-container `grokzen/redis-cluster` (6-node)
> on ports 7100–7105 — Docker Desktop for Mac can't expose discrete cluster nodes to the
> host. Logically still a 6-node cluster; production would use discrete nodes.

---

## Run the full app (Phase 1 + 2)

Bring up infra, then the order pipeline and whichever frontend(s) you want — each in its own
terminal (or background them):

```bash
pnpm infra:up          # Postgres, Mongo, Redpanda (+Schema Registry :18081), Temporal, Redis Cluster
pnpm db:deploy         # apply Prisma migrations (event store, outbox, users)
pnpm seed:users        # (Phase 2a) seed demo users — role@tenant.test / devpassword
pnpm register:schemas  # (Phase 3b, one-time) register Avro schemas with BACKWARD compatibility
```

> Phase 2 RLS: `pnpm db:deploy` also creates the restricted `flashbite_app` Postgres role.
> write-api + saga-worker connect as it via `APP_DATABASE_URL` so Row-Level Security enforces
> tenant isolation on `event_store`/`outbox`; the outbox-poller stays on the superuser
> `DATABASE_URL` (it relays every tenant's events).

```bash

# order plane
pnpm dev:write-api     # :3001  place orders, relay merchant accept/decline
pnpm dev:read-api      # :3002  queries, SSE, telemetry ingest + nearby
pnpm dev:outbox        # outbox  -> Kafka
pnpm dev:projection    # Kafka   -> Mongo read model
pnpm dev:saga          # Temporal order-lifecycle workflow (charge / SLA / accept|refund)
pnpm dev:telemetry     # Kafka telemetry-streams -> Redis geo

# frontends (each proxies /api/identity -> :3003, /api/read -> :3002, /api/write -> :3001)
pnpm dev:identity      # :3003  JWT identity service — MUST be running for login
pnpm dev:web-customer  # :3100  storefront + order tracking
pnpm dev:web-merchant  # :3101  live order queue, accept/decline
pnpm dev:web-driver    # :3102  nearby-drivers map (needs NEXT_PUBLIC_MAPBOX_TOKEN for tiles)
pnpm dev:web-admin     # :3103  cross-tenant GMV/analytics + driver maps
```

> **Login required (Phase 2 S4):** after `pnpm seed:users`, every UI requires a logged-in user.
> Use seeded credentials (`role@tenant.test` / `devpassword`), e.g. `customer@berlin.test`,
> `merchant@berlin.test`, `driver@berlin.test`; the admin dashboard uses `operator@flashbite.test`.
> `pnpm dev:identity` must be running — each frontend reaches it same-origin via the
> `/api/identity/*` Next.js rewrite.

| Surface | URL | Surface | URL |
|---|---|---|---|
| Customer | <http://localhost:3100> | write-api | <http://localhost:3001> |
| Merchant | <http://localhost:3101> | read-api | <http://localhost:3002> |
| Driver | <http://localhost:3102> | Temporal UI | <http://localhost:8080> |
| Admin | <http://localhost:3103> | Redpanda Console | <http://localhost:8085> |

Tenancy + role come from the **verified JWT** (`Authorization: Bearer`) — the frontends obtain it at
login and send it for you; the old `X-Tenant-ID` header is no longer accepted. Maps use a public
`NEXT_PUBLIC_MAPBOX_TOKEN` (a fallback panel renders without one). **Tests:** `pnpm test`
(backend, needs infra up), `pnpm --filter @flashbite/web-shared test` (frontend units), and
`pnpm test:e2e:<customer|merchant|driver|admin>` (Playwright, needs the relevant services + identity
up, users seeded).

---

## Driver telemetry (Phase 1c-ii)

Ephemeral driver locations stream into Redis geo and are queryable per tenant:

```bash
pnpm infra:up
pnpm dev:identity      # http://localhost:3003 (login + JWKS) — needed for a token
pnpm dev:read-api      # http://localhost:3002 (location ingest + nearby query)
pnpm dev:telemetry     # telemetry-streams → Redis geo
pnpm seed:users        # role@tenant.test / devpassword

# stream simulated GPS pings (random walk) until Ctrl+C — logs in for a driver JWT first
./scripts/stream-gps.sh
# tune: DRIVER=drv-7 TENANT=tokyo INTERVAL=0.5 ./scripts/stream-gps.sh

# …or by hand (tenant comes from the token, not a header):
TOKEN=$(curl -s -XPOST localhost:3003/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"driver@berlin.test","password":"devpassword"}' \
  | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')
curl -XPOST localhost:3002/drivers/drv-1/location \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" \
  -d '{"lng":13.405,"lat":52.52}'                         # → 202
curl "localhost:3002/drivers/nearby?lng=13.405&lat=52.52&radiusKm=5" \
  -H "Authorization: Bearer $TOKEN"                       # → nearby drivers (tenant from token)
```

Telemetry is **ephemeral** — Redis geospatial only, never Postgres / the event store.
Per-tenant isolation holds on both write and read (`tenant:{id}:drivers:geo`), scoped by the
token's tenant. Manual requests live in [`apps/write-api/requests.http`](apps/write-api/requests.http); see
[`docs/superpowers/plans/phase-1c-ii-verification.md`](docs/superpowers/plans/phase-1c-ii-verification.md).
