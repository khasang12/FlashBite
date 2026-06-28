# Phase 4a — Observability Story (Design)

**Status:** approved (brainstorm) — pending implementation plan
**Slice of:** Phase 4 (frontend polish + observability). This spec covers **4a (observability)** only;
4b (frontend polish) and 4c (ADRs + demo walkthrough) are separate slices.

## Goal

Every log line across every service and worker is **structured JSON**, automatically tagged with
`service`, `tenantId`, `eventId` (where applicable), and a **`correlationId` that follows a single
order end-to-end** — HTTP request → `event_store`/outbox → Kafka headers → projection / saga /
telemetry / SSE consumers. Grep one `correlationId` and watch the whole distributed lifecycle.

This replaces today's ad-hoc logging: 14 files use raw `console.*`, only 2 use NestJS `Logger`, and
there is no cross-service correlation. The two observability UIs already exist (Temporal Web :8080,
Redpanda Console :8085) and are reused, not rebuilt.

## Non-goals (YAGNI)

- No Prometheus / Grafana / OpenTelemetry collector, no `/metrics` endpoints, no Loki/log
  aggregation. Output is **structured JSON to stdout** only (Docker/terminal captures it). The master
  spec asks for "structured logs carrying tenantId+eventId" — not a metrics stack.
- No new infra containers.
- No frontend (browser) logging — services and workers only. (Frontend is slice 4b.)

## Architecture

### 1. Shared logging core (`packages/shared`)

- **`logger.ts`** — `createLogger(service: string)` returns a configured **pino** logger:
  - JSON to stdout in production; `pino-pretty` transport when `NODE_ENV !== "production"`.
  - Level from `LOG_LEVEL` env (default `info`).
  - A pino **`mixin`** that merges the current `obsContext` (see below) into every line, so call
    sites never pass context manually.
  - A bound `service` field on every line.
- **`obs-context.ts`** — an `AsyncLocalStorage<ObsContext>` where
  `ObsContext = { service: string; correlationId: string; tenantId?: string; eventId?: string }`.
  Exports:
  - `runWithObsContext(ctx, fn)` — run a callback with context bound.
  - `getObsContext(): ObsContext | undefined` — current context (used by the logger mixin and by
    the write path to stamp `correlationId`).
  - `newCorrelationId(): string` — uuid v4 (via `node:crypto.randomUUID`).

A **plain pino factory (not `nestjs-pino`)** so the identical logger serves both NestJS services and
plain-TS workers, and to avoid the documented NestJS/pnpm cross-package `instanceof` gotcha.

### 2. Envelope + header propagation (`packages/contracts`, `packages/messaging`)

- Add `correlationId: string` to `EventEnvelope` (it is persisted as JSON in the outbox `payload`
  column, so **no DB migration**).
- `EnvelopeMeta` gains `correlationId`; `buildHeaders` emits a `correlationId` header.
- `parseHeaders` reads `correlationId` **leniently**: if missing/empty it returns a freshly minted
  id (back-compat for pre-4a messages still on the bus / in the event store), while `eventType`,
  `tenantId`, `eventId` remain fail-closed/required as today.

### 3. HTTP edge (`packages/tenant-context`)

- A correlation middleware/interceptor that runs per request:
  - Reads inbound `x-correlation-id`; if absent, mints one via `newCorrelationId()`.
  - Binds `{ service, correlationId, tenantId }` into `obsContext` (tenantId from the existing auth
    ALS once auth has resolved; unauthenticated/`/health` requests log with `tenantId` absent).
  - Echoes the `x-correlation-id` on the response header.
  - Emits **one request-completion log line** per request (all endpoints): `method`, `path`,
    `statusCode`, `durationMs`. (Decision: every endpoint, not only mutations — one line each is
    cheap and makes the trace legible for the demo.)

### 4. Write path (`apps/write-api`, `packages/shared/aggregate-store.ts`)

- When `aggregate-store` builds an `EventEnvelope`, it stamps `correlationId` from
  `getObsContext()?.correlationId` (falling back to a minted id if somehow unset). The envelope is
  written into the outbox `payload` JSON in the same transaction as today — unchanged otherwise.

### 5. Outbox → Kafka (`apps/outbox-poller`)

- `publishEnvelope` already forwards the stored envelope; with `correlationId` in `EnvelopeMeta` +
  `buildHeaders`, the header is emitted. The poller binds an `obsContext` per row it publishes
  (`correlationId`, `tenantId`, `eventId`) so its own logs are correlated.

### 6. Consumers (`projection-worker`, `saga-worker`, `telemetry-worker`, `read-api` SSE feeder)

- Each consumer, per message: `parseHeaders` → `runWithObsContext({ service, correlationId,
  tenantId, eventId }, () => handle(msg))`. All logs emitted during handling carry the context.
- **Saga forwards the chain:** the `correlationId` from the consumed message is attached to the
  accept/cancel (and dispatch) events the saga appends, so the id stays stable across the saga's own
  writes back into the event store.

### 7. Replace `console.*`

- Swap the 14 `console.{log,error,warn}` call sites for a module-level `createLogger(<service>)`.
  Errors log with the error object (pino serializes stack) plus the ambient context.

## Data flow (one order)

```
customer HTTP POST /orders            obsContext{cid=C, tenant=berlin}
  └─ write-api logs "order placed" (cid=C)
  └─ aggregate-store: envelope.correlationId = C  → outbox.payload (JSON)
outbox-poller publishes → Kafka header correlationId=C
  ├─ projection-worker  parseHeaders→cid=C, logs "projected" (cid=C)
  ├─ saga-worker        cid=C; appends OrderAccepted with correlationId=C → loops back through poller
  └─ telemetry/SSE      cid=C
```

Grep `correlationId=C` (or `"correlationId":"C"`) across stdout → the full lifecycle.

## Error handling

- A missing inbound `correlationId` is normal → mint one (never error).
- Malformed Kafka envelopes still fail closed on `eventType`/`tenantId`/`eventId` (unchanged);
  `correlationId` alone never causes a reject.
- Logger initialization must not throw at import time; `createLogger` is pure config.

## Testing

- **Unit (vitest/jest per package):**
  - `messaging` header serde: `correlationId` round-trips through `buildHeaders`/`parseHeaders`;
    a message without it parses to a freshly minted id (lenient), while missing
    `eventType`/`tenantId`/`eventId` still throws.
  - `shared` logger/obs-context: a log emitted inside `runWithObsContext` includes `service`,
    `correlationId`, `tenantId` via the mixin; outside any context it omits them without throwing.
- **Live e2e (project style, infra up):** place an order via write-api with a known
  `x-correlation-id`; assert the same id appears on the resulting Kafka message's `correlationId`
  header (and/or the persisted outbox envelope).

## Affected files (map)

- Create: `packages/shared/src/logger.ts`, `packages/shared/src/obs-context.ts` (+ tests).
- Modify: `packages/contracts/src/index.ts` (EventEnvelope), `packages/messaging/src/headers.ts`
  (+ test), `packages/tenant-context/src/*` (correlation middleware/interceptor + export),
  `packages/shared/src/aggregate-store.ts`, `apps/outbox-poller/src/poller.ts`,
  `apps/projection-worker/*`, `apps/saga-worker/*`, `apps/telemetry-worker/*`,
  `apps/read-api/*` (SSE feeder), and the 14 `console.*` sites.
- Docs: an **Observability** section in `README.md` / `docs/ARCHITECTURE.md` (read structured logs,
  grep by `correlationId`, the Temporal/Redpanda UIs) + a new env var `LOG_LEVEL` (default `info`).

## Exit criteria

- All services/workers emit structured JSON; no remaining `console.*` in app/worker code paths.
- A single `correlationId` is greppable across write-api → poller → projection/saga/telemetry for one
  order, verified by the live e2e.
- Docs explain how to read the logs and the two UIs.
