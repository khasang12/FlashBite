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
