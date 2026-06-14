# FlashBite — Backlog / Future Work

Ideas captured for later phases. Not scheduled; no implementation yet.

## Driver safety score (telemetry analytics)

**Goal:** Derive a per-driver **safety score** from streamed GPS telemetry — e.g. harsh
acceleration/braking, speeding vs. road limits, sharp cornering, erratic movement —
per tenant.

**Why a data layer is a prerequisite:** the live Redis geo index is ephemeral. `GEOADD`
overwrites a member's position (latest wins), so it only answers "where is the driver
now" and **cannot reconstruct a trajectory**. Safety scoring needs *history* — a time-
ordered sequence of pings per driver.

**Where the history comes from (no change to the hot path):** `telemetry-streams` is
already the durable, ordered log (keyed `tenantId:driverId`, so per-driver order is
preserved). Do **not** add DB writes to the ingest endpoint or `telemetry-worker`.
Instead add a separate `telemetry-archiver` consumer (its own consumer group) that
batch-writes pings to an analytics store.

```
                         ┌─► telemetry-worker  ─► Redis geo (live, ephemeral)
POST ─► telemetry-streams ┤
                         └─► telemetry-archiver ─► analytics store (history)  ← new
```

**Sink choice (decide by query shape):** PostGIS (geo queries on Postgres) ·
TimescaleDB (time-series at volume) · ClickHouse (columnar analytics) ·
Parquet/object storage (cheap cold archive for batch/ML).

**Cheap prerequisite, safe to do anytime:** raise `telemetry-streams` retention so the
history is buffered and **backfillable** once the archiver + sink land.

**Rough shape:**
1. `telemetry-archiver` → analytics store (append-only ping history).
2. Batch/stream job computes per-driver safety features → score.
3. Expose the score (read-api endpoint + admin grid in Phase 1d).

Telemetry stays out of the event store (not part of the order aggregate); this analytics
plane is independent of the "telemetry is ephemeral" decision for the live layer.

## Push-based live order status (replace customer polling with SSE)

**Goal:** The customer order-tracking page (`apps/web-customer/app/orders/[orderId]/page.tsx`)
currently **polls** `GET /api/read/orders/:id` every 2s until the order reaches a terminal
status. Replace the poll with a **push** channel so the UI updates instantly and stops
hammering the read API.

**Why:** Polling forces a cap-vs-SLA tuning problem — the FE must keep polling longer than
`SAGA_SLA_SECONDS` (default 300s) just to catch the SLA-breach `CANCELLED`. It also wastes
requests while a `PLACED` order waits out the merchant SLA. A push channel removes the
tuning entirely and is the right fit for live status.

**Where the infra already exists:** read-api already runs an SSE feeder
(`GET /merchant/orders/stream`, consumer group `read-api-sse`) that filters `order-events`
by tenant. That stream is **tenant-wide (merchant view)**, not per-order/per-customer.

**Rough shape:**
1. Add a customer-facing SSE endpoint (e.g. `GET /orders/:id/stream`, tenant-scoped) that
   emits status transitions for one order from the `order-events` subscription, closing on
   terminal status.
2. Frontend: a small `useOrderStream(orderId)` hook in `web-shared` (EventSource via the
   same-origin rewrite) replaces the poll loop; keep a short poll/refetch as a fallback for
   reconnects.
3. When the merchant dashboard (1d-ii) lands, both surfaces share the same SSE plumbing.

Until then, the tracking page polls with a bounded cap (>SLA) + tab-hidden pause + manual
refresh — adequate, but the SSE channel is the proper fix.
