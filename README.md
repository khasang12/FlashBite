# FlashBite

A multi-tenant, hyper-local delivery platform built as a **distributed-systems
architecture showcase** — one order journey taken end-to-end through every serious
backend pattern, with a second tenant present purely to prove isolation.

> Portfolio / learning project. The value is depth: each pattern is built in
> "hard mode," and the whole thing runs locally end-to-end.

---

## What it demonstrates

A single order flows through **every box** in the architecture:

```
NextJS storefront
   │  place order (verified JWT → tenant context)
   ▼
write-api ──(atomic tx)──► Postgres event store + outbox
   │                                   │
   │                          outbox-poller
   │                                   ▼
   │                         Redpanda (Kafka, Avro)
   │                          ╱                ╲
   ▼                  projection-worker     saga-worker (Temporal)
read-api ◄── Redis Cluster ◄── Mongo        SLA timer ⇄ merchant signal
(SSE)                                        compensation on breach
```

Plus a real-time **telemetry plane** (ephemeral — Redis geo only, never persisted):

```
driver GPS pings
   │  POST /drivers/:id/location  →  read-api
   ▼
telemetry-streams (Kafka)
   │
   ▼
telemetry-worker ──► Redis Cluster geo  (GEOADD into tenant:{id}:drivers:geo)
                              ▲
   GET /drivers/nearby ───────┘  read-api (GEOSEARCH, per-tenant)
```

- **Multi-tenancy** — Postgres Row-Level Security, subdomain routing, `tenantId`
  propagated through every tier from a verified JWT (never a spoofable header).
- **CQRS + Event Sourcing + Transactional Outbox** — atomic write of event + outbox row,
  forward-only and rebuildable projections.
- **Kafka (via Redpanda) + Schema Registry** — Avro envelopes, per-order partition keys
  (`tenantId:orderId`) for ordering.
- **Temporal sagas** — per-tenant SLA timers raced against merchant-approval signals,
  with compensation (refund + tenant-branded cancellation) on breach.
- **Polyglot persistence** — Postgres (write), Mongo (read models), Redis Cluster
  (cache + geo, `tenant:{id}` hash-tag co-location).
- **Real-time telemetry** — ephemeral driver GPS streamed (`DriverTelemetryStreamed` on
  `telemetry-streams`) into per-tenant Redis geospatial indices and served via `GEOSEARCH`
  (`GET /drivers/nearby`); high-velocity, tenant-isolated, never persisted to Postgres.
- **Idempotency & dedup** — first-class at every hop (inbox pattern, stable `eventId`,
  Temporal `WorkflowId` reuse policy).
- **Dedicated identity service** — issues signed JWTs so tenant isolation rests on
  cryptographic identity, not trust.

See the full design in
[`docs/superpowers/specs/2026-06-13-flashbite-showcase-design.md`](docs/superpowers/specs/2026-06-13-flashbite-showcase-design.md).

---

## Tech stack

NestJS · NextJS · Kafka (Redpanda) + Schema Registry · Temporal · PostgreSQL + Prisma ·
MongoDB · Redis Cluster · TypeScript · pnpm monorepo · Docker Compose.

## Monorepo layout

```
apps/        identity, write-api, read-api, projection-worker, outbox-poller,
             saga-worker, telemetry-worker, web-customer, web-merchant,
             web-driver, web-admin
packages/    contracts (Avro + envelope), tenant-context, shared
infra/       docker-compose.yml + runbook
spikes/      Phase 0 de-risking scripts (throwaway)
docs/        specs and per-phase plans
```

---

## Roadmap

The master spec decomposes the build into phases, each its own plan → implement cycle:

| Phase | Goal | Status |
|-------|------|--------|
| **0** | Infra up + de-risk Kafka / Temporal / outbox / Redis Cluster | ✅ complete |
| 1 | Walking skeleton — one tenant, one order, end-to-end (CQRS/ES/outbox, projection, SSE, Temporal saga, driver telemetry) | 🚧 in progress |
| 2 | Two tenants + identity + isolation hard mode | planned |
| 3 | Deepen every box to hard mode (full ES, Avro, saga, geo) | planned |
| 4 | Frontend polish + observability story | planned |

Phase 1 is built in vertical slices: **1a** write path (event store + outbox), **1b**
read path (projection + Redis cache + SSE), **1c-i** Temporal order-lifecycle saga,
**1c-ii** driver telemetry (Redis geo + nearby query).

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

## Driver telemetry (Phase 1c-ii)

Ephemeral driver locations stream into Redis geo and are queryable per tenant:

```bash
pnpm infra:up
pnpm dev:read-api      # http://localhost:3002 (location ingest + nearby query)
pnpm dev:telemetry     # telemetry-streams → Redis geo

# stream simulated GPS pings (random walk) until Ctrl+C
./scripts/stream-gps.sh
# tune: DRIVER=drv-7 TENANT=tokyo INTERVAL=0.5 ./scripts/stream-gps.sh

# …or by hand:
curl -XPOST localhost:3002/drivers/drv-1/location \
  -H 'Content-Type: application/json' -H 'X-Tenant-ID: berlin' \
  -d '{"lng":13.405,"lat":52.52}'                         # → 202
curl "localhost:3002/drivers/nearby?lng=13.405&lat=52.52&radiusKm=5" \
  -H 'X-Tenant-ID: berlin'                                # → nearby drivers (tenant-scoped)
```

Telemetry is **ephemeral** — Redis geospatial only, never Postgres / the event store.
Per-tenant isolation holds on both write and read (`tenant:{id}:drivers:geo`). Manual
requests live in [`apps/write-api/requests.http`](apps/write-api/requests.http); see
[`docs/superpowers/plans/phase-1c-ii-verification.md`](docs/superpowers/plans/phase-1c-ii-verification.md).
