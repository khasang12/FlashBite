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

- **Multi-tenancy** — Postgres Row-Level Security, subdomain routing, `tenantId`
  propagated through every tier from a verified JWT (never a spoofable header).
- **CQRS + Event Sourcing + Transactional Outbox** — atomic write of event + outbox row,
  forward-only and rebuildable projections.
- **Kafka (via Redpanda) + Schema Registry** — Avro envelopes, per-order partition keys
  (`tenantId:orderId`) for ordering.
- **Temporal sagas** — per-tenant SLA timers raced against merchant-approval signals,
  with compensation (refund + tenant-branded cancellation) on breach.
- **Polyglot persistence** — Postgres (write), Mongo (read models), Redis Cluster
  (cache + geo, `{tenant:id}` hash-tag co-location).
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
| 1 | Walking skeleton — one tenant, one order, end-to-end | planned |
| 2 | Two tenants + identity + isolation hard mode | planned |
| 3 | Deepen every box to hard mode (full ES, Avro, saga, geo) | planned |
| 4 | Frontend polish + observability story | planned |

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
