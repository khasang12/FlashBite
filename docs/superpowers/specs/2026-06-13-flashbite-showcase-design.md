# FlashBite — Multi-Tenant Showcase Master Spec

**Date:** 2026-06-13
**Status:** Approved design — master spec (spawns per-phase plans)
**Source:** Reiteration of `PRD-001-FlashBite-MVP.html`

---

## 1. Purpose & framing

FlashBite is a **portfolio/showcase** project: a multi-tenant, hyper-local delivery
platform whose value is demonstrating distributed-systems architecture skill. It must
**run convincingly end-to-end** and present a **balanced** surface — real backend
patterns (observable through Temporal/Kafka UIs) *and* a presentable frontend across the
golden path.

Two decisions frame everything below:

- **Pattern depth: hard mode everywhere.** Full-fidelity Event Sourcing, Avro + Schema
  Registry, Postgres Row-Level Security, and a complete Temporal saga. The depth is the
  differentiator.
- **Builder experience: mixed.** Strong on NestJS/NextJS/Postgres; newer to
  Kafka/Temporal/Event Sourcing. The plan front-loads de-risking the unfamiliar pieces.

Because *hard mode everywhere* fights *must run convincingly*, the resolution is
**depth-first on one golden path** (build one complete journey through every
architectural box) plus a second tenant that exists only to **prove isolation**. We do
**not** build all domains broadly.

This is a **master spec**. Each phase (Section 6) becomes its own `plan → implement`
cycle.

---

## 2. Scope

### 2.1 The golden path (built deeply)

A customer on `berlin-eats.flashbite.com` places an order that traverses **every box**
in the architecture and reaches a terminal state, two ways:

1. **Happy path:** order placed → payment charged → merchant accepts within SLA (SSE) →
   driver assigned → GPS telemetry streams → fulfillment finalized → read models +
   dashboards update.
2. **Compensation path:** merchant lets the SLA timer expire → Temporal fires
   compensation → payment refunded → tenant-branded cancellation → SLA breach recorded in
   the tenant metrics ledger.

### 2.2 Tenant #2 — isolation proof, not features

`tokyo-sushi.flashbite.com` exists to **prove isolation**: different SLA config,
different currency/branding, and a demonstrable guarantee that Tenant A's
orders/customers/telemetry never appear in Tenant B's reads, caches, partitions, or
workflows.

### 2.3 Frontends (thin but presentable)

- **Customer storefront** — menu + checkout (`{tenant}.flashbite.com`)
- **Merchant dashboard** — live SSE order queue + accept button
- **Driver view** — accept dispatch + emit GPS
- **Admin telemetry** — `admin.flashbite.com`: GMV, live order states, isolation proof

### 2.4 Domain depth

One restaurant + one seeded menu per tenant. Richness lives in the architecture, not the
catalog.

### 2.5 Explicitly out of scope (deliberate, named for reviewers)

Heavy auth features (OAuth/social providers, MFA, password-reset flows, refresh-token
rotation — the identity service ships minimal: tenant-scoped users, login → JWT, token
validation, role claim); real payment provider (fake gateway activity instead);
menu/catalog CRUD; driver fleet matching/optimization algorithms; mobile apps; real maps
(telemetry on a simple canvas); horizontal scaling / k8s; multi-region.

> Note: a **dedicated identity service is in scope** (Section 3.5) — it is what makes the
> tenant isolation claim trustworthy rather than spoofable. Only the advanced auth
> features above are deferred.

---

## 3. Architecture

### 3.1 Monorepo layout

```
flashbite/
  apps/
    identity/          NestJS — tenant-scoped users, login -> JWT, token validation (own DB)
    write-api/         NestJS — commands, event store, outbox (Postgres, atomic)
    read-api/          NestJS — queries from Mongo + Redis; SSE endpoint for merchants
    projection-worker/ NestJS — Kafka consumer -> Mongo read models
    outbox-poller/     NestJS — Postgres outbox -> Kafka (Avro)
    saga-worker/       Temporal worker — order lifecycle workflow + activities
    telemetry-worker/  Kafka consumer — driver GPS -> Redis geo
    web-customer/      NextJS — subdomain storefront + checkout
    web-merchant/      NextJS — SSE order queue + accept
    web-driver/        NextJS — dispatch + GPS emitter
    web-admin/         NextJS — global telemetry grid
  packages/
    contracts/         Avro schemas + generated TS types, event envelope
    tenant-context/    AsyncLocalStorage middleware, tenant resolver, RLS session helper
    shared/            config, logging, Prisma client, Mongo/Redis clients
  infra/               docker-compose.yml, topic provisioning, seed scripts
```

### 3.2 The three planes (CQRS + Event Sourcing + Outbox)

- **Command plane:** NextJS → write-api → single Postgres transaction writing **both**
  the event-store row and the outbox row (one atomicity boundary) → outbox-poller →
  Kafka (Avro, key = `tenantId:aggregateId`). Broker is **Redpanda** (Kafka
  wire-compatible) with its built-in Schema Registry.
- **Query plane:** Kafka → projection-worker → Mongo (tenant-scoped collections) → Redis
  Cluster cache (`{tenant:tenantId}:{domain}:{resourceId}`) → read-api → NextJS.
- **Orchestration plane:** Kafka → saga-worker → Temporal workflow
  (`WorkflowId = tenantId:orderId`) calling activities (payment, refund, config lookup)
  and reacting to the merchant-approval signal.

### 3.3 Tenant context — the spine

A tenant-resolver derives `tenantId` from the **verified JWT claim** issued by the
identity service (Section 3.5) — never from a raw, client-set header — and populates
`AsyncLocalStorage`. The subdomain selects which tenant's login/storefront is served;
the signed token is what *authorizes* tenant access. For service-to-service calls the
verified context is propagated as a signed token, not a trusted plain header. The same
`tenantId` then propagates into:

- the **RLS session var** on every Postgres transaction,
- the **Kafka message key** + envelope header,
- the **Temporal `WorkflowId`** and workflow arguments,
- the **Mongo query filter**,
- the **Redis Cluster hash-tag key prefix** `{tenant:tenantId}` (co-locates a tenant's
  keys on one hash slot).

This propagation is the single most load-bearing thing in the system — it is what makes
the isolation claim true at every tier, and the first thing a reviewer will probe.

### 3.4 Event envelope

One shape, defined once in `contracts/` and used everywhere:
`{ tenantId, eventId, eventType, version, occurredAt, payload }`. Drives consistent
versioning, tracing, and dedup.

### 3.5 Identity service (`apps/identity`)

A dedicated NestJS service with its own database (tenant-scoped users + credentials). It
is the **source of trust** for tenant identity:

- **Login → JWT.** A user authenticates against their tenant; the service issues a signed
  JWT carrying `{ tenantId, userId, role }`. A user belongs to exactly one tenant and the
  service can never mint a token for a different tenant.
- **Token validation.** Every other service validates the signature and derives the
  verified `tenantId` from the claim — this is what feeds the tenant-context spine
  (Section 3.3). No service trusts a raw `X-Tenant-ID` header from a client.
- **Roles.** Minimal role claim (`customer`, `merchant`, `driver`, `admin`) so each
  frontend authorizes against the right surface.
- **Scope.** Minimal by design — login, validation, role claim. Advanced auth (OAuth/
  social, MFA, password reset, refresh-token rotation) is explicitly out of scope (2.5).

This is also a demonstrable security moment: attempt to use Tenant A's token against
Tenant B's storefront/API and show it is rejected.

### 3.6 Idempotency & deduplication (cross-cutting, first-class)

At-least-once delivery is inherent (outbox can re-send; consumers can re-process on
rebalance/restart). Dedup is designed in at every hop:

- **Command ingress (write-api):** client supplies an idempotency key (client-generated
  `orderId` + `Idempotency-Key` header for retries). Handler checks the event store for
  an existing aggregate/event before appending; duplicate submissions collapse to one
  event and return the original result.
- **Outbox → Kafka:** every event carries a stable `eventId` (UUID). Rows move
  `PENDING → SENT` transactionally; a row may publish twice (acceptable — consumers
  dedupe).
- **Consumers (inbox pattern):** a `processed_events` store keyed by
  `(tenantId, consumerName, eventId)`. Each handler: *seen → skip; not seen → apply +
  record, in one transaction.* Combined with idempotent **upserts** keyed by aggregate id
  + version, replays/duplicates converge to the same state.
- **Ordering / stale-write guard:** projections track the last applied aggregate
  `version` and ignore older/out-of-order events.
- **Temporal:** natural dedup via `WorkflowId = tenantId:orderId` + a
  `WorkflowIdReusePolicy` rejecting duplicate starts. Activities are retry-safe
  (charge/refund keyed by `orderId`).

Demonstrable moment: re-publish an event / double-submit an order and show read model +
ledger stay correct.

---

## 4. Multi-tenant isolation strategy (hard mode)

- **Identity (the root of trust):** `tenantId` originates from a signed JWT claim issued
  by the identity service — not a client header. Every tier below inherits a *verified*
  tenant id, so the isolation guarantees rest on cryptographic identity, not trust.
- **Postgres:** shared DB, Row-Level Security. Every table has an indexed `tenant_id`;
  policies enforce it; the `tenant-context` package issues `SET LOCAL app.tenant_id`
  inside each transaction (see correction 4.3 #3).
- **Kafka (Redpanda):** shared topics (`order-events`, `telemetry-streams`); isolation
  via partition key `tenantId:aggregateId` so a tenant's events stay ordered on one
  partition.
- **Temporal:** `WorkflowId = tenantId:orderId`; `tenantId` is a mandatory root workflow
  argument.
- **Redis Cluster:** immutable key pattern `{tenant:tenantId}:{domain}:{resourceId}`. The
  `{...}` hash tag co-locates a tenant's keys on one hash slot — enabling per-tenant
  multi-key ops and keeping GEO commands within a single tenant's slot. Client is
  cluster-aware.
- **Mongo:** tenant-scoped collections / mandatory `tenantId` filter on every query.

---

## 5. Corrections to the PRD's code (recorded as deliberate fixes)

1. **Wrong import:** `from 'async-hooks'` → `from 'node:async_hooks'`. As written it
   would not run.
2. **Broken SLA race:** the workflow registers `merchantApprovalSignal` **twice**; the
   second `setHandler` overwrites the first and tangles `isApprovedByMerchant` with the
   race result. Fix: a single signal handler resolving a workflow-level promise/condition,
   raced against `sleep(sla)` (Temporal `condition`/`Trigger`). This saga is the
   centerpiece and must be correct.
3. **RLS ≠ Prisma out of the box:** RLS needs `SET LOCAL app.tenant_id = '...'` per
   transaction; Prisma won't do it automatically. The `tenant-context` package provides a
   transaction wrapper that sets the session var before queries.
4. **Temporal shares the app Postgres:** give Temporal its own database/instance so the
   event store and Temporal internal state don't entangle.
5. **Secrets inline:** replace literal `framework_master_secret` with `.env` +
   `.env.example`; the repo never ships a literal secret.
6. **Idempotency absent from PRD:** now first-class (Section 3.6).
7. **Spoofable tenant context:** the PRD derives `tenantId` from a client-set
   `X-Tenant-ID` header, which undermines the entire isolation thesis (any client could
   impersonate another tenant). Fixed by sourcing `tenantId` from a verified JWT claim
   issued by the dedicated identity service (Section 3.5).

---

## 6. Phase roadmap (Approach A: walking skeleton → deepen)

Each phase is independently demoable and becomes its own `plan → implement` cycle.

### Phase 0 — Infra + isolation spikes (de-risk the unfamiliar)
Stand up `docker-compose`: Postgres, Mongo, **Redis Cluster (6 nodes: 3 masters + 3
replicas)**, **Redpanda** (+ Redpanda Console; built-in Schema Registry), Temporal (on
its own DB). Four throwaway spikes, each a learning checkpoint with a "prove it works"
exit: (a) Kafka produce→consume with a partition key (against Redpanda); (b) a Temporal
hello-workflow with a timer + signal; (c) outbox row → poller → Kafka round-trip; (d)
Redis Cluster forms quorum and `{tenant:id}` hash-tag keys land co-located on one slot.
**Exit:** all containers healthy; cluster reaches `cluster_state:ok`; each spike
demonstrably runs.

### Phase 1 — Walking skeleton, one tenant, end-to-end
One hardcoded tenant. Order flows through every box with the simplest honest
implementation: JSON on the wire (not Avro yet), forward-only projection, fake payment
activity, Temporal lifecycle workflow present with a fixed SLA. **Idempotency keys + inbox
table go in now** (cheaper than retrofitting).
**Exit:** place an order in the customer UI → it traverses write-api → outbox → Kafka →
projection → Mongo → read-api → merchant dashboard (SSE) → accept → driver telemetry →
fulfillment finalized. It runs.

### Phase 2 — Two tenants + identity + isolation hard mode
Add `tokyo-sushi`, subdomain resolution, and the **identity service** (login → JWT,
token validation) so the tenant-context spine runs on *verified* tenant ids end-to-end.
Turn on Postgres RLS with session vars, Redis hash-tag namespacing, Kafka partition-key
isolation, Mongo tenant filters.
**Exit:** isolation proof — Tenant A data provably absent from every Tenant B tier;
Tenant A's token rejected against Tenant B; the dedup/idempotency demo passes.

### Phase 3 — Deepen each box to hard mode
Full event sourcing (rebuildable projections from the event log + a replay command);
Avro + Schema Registry with the versioned envelope; complete Temporal saga (dynamic
per-tenant SLA lookup, compensation, merchant-approval signal, penalty ledger);
high-frequency telemetry with Redis geo indices.
**Exit:** compensation path works; a projection can be dropped and rebuilt from events.

### Phase 4 — Frontend polish + observability story
Bring the four UIs to presentable (tenant branding, live states, driver coords on a
simple canvas, admin GMV/telemetry grid). Wire observability: Temporal Web UI (saga
timelines), a Kafka UI container (partitions/consumer groups), structured logs carrying
`tenantId`+`eventId`, README with architecture diagrams + ADRs + a "how to run the demo"
script.
**Exit:** a clean end-to-end demo anyone can run, and a repo that reads well.

---

## 7. Success criteria

- Both tenant storefronts run; an order completes **both** the happy path and the
  compensation path end-to-end.
- The **isolation proof** holds at every tier (identity/DB/Kafka/Temporal/Redis/Mongo),
  including a verified-token check: Tenant A's JWT is rejected against Tenant B.
- The **dedup/idempotency demo** passes (double-submit + event replay → state stays
  correct).
- A **projection rebuild** from the event log reproduces identical read state.
- One-command `docker-compose up` + seed script + documented demo walkthrough.

---

## 8. Testing & observability

**Testing:** unit tests on the saga (happy + SLA-breach + signal) and on idempotent
handlers; integration tests per data plane (outbox→Kafka→projection round-trip; RLS
denies cross-tenant access; identity rejects a cross-tenant token); one end-to-end test
driving the golden path. Hard mode → saga and isolation get the heaviest coverage.

**Observability (as showcase):** Temporal Web UI (saga timelines); **Redpanda Console**
(topics/partitions/consumer groups/schemas); structured logs carrying `tenantId` +
`eventId` for traceability; the admin grid surfacing GMV + live order states.

---

## 9. Tech stack (from the PRD, retained)

NestJS (microservices, incl. a dedicated **identity service** issuing JWTs), NextJS
(UIs), **Kafka via Redpanda** + built-in Schema Registry
(Avro) + Redpanda Console, Temporal (orchestration), PostgreSQL + Prisma (write side /
event store / outbox), MongoDB (read models), **Redis Cluster** (6 nodes; cache + geo,
tenant co-location via `{tenant:id}` hash tags). Local-only via `docker-compose`.
