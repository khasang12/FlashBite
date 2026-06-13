# Phase 1b — Verification

Prereq: `pnpm infra:up` (Postgres, Redpanda, MongoDB, Redis Cluster).

## Automated
`pnpm test` — Phase 1a + 1b suites (shared mongo/redis, projection-worker apply + consumer,
read-api health/query/cache-aside/stream/SSE).

## Manual end-to-end (command + query plane)
1. `pnpm dev:write-api` (3001), `pnpm dev:outbox`, `pnpm dev:projection`, `pnpm dev:read-api` (3002)
2. POST an order to write-api `/orders` (X-Tenant-ID: berlin).
3. GET read-api `/orders/<id>` -> returns the projected OrderView (status PLACED).
4. Optional: `curl -N localhost:3002/merchant/orders/stream -H 'X-Tenant-ID: berlin'` shows the live event.

Read side: projection-worker (Kafka -> Mongo, inbox dedup) + read-api (Mongo + Redis cache-aside + SSE).
Phase 1c adds the Temporal order-lifecycle saga + driver telemetry.
