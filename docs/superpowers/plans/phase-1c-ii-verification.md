# Phase 1c-ii — Verification

Prereq: `pnpm infra:up` (Redpanda + Redis Cluster at minimum).

## Automated
`pnpm test` — contracts telemetry (geo key), telemetry-worker (applyTelemetry + consumer),
read-api (telemetry ingest -> telemetry-streams, GET /drivers/nearby GEOSEARCH, tenant isolation).

## Manual end-to-end
1. `pnpm dev:read-api` (3002) + `pnpm dev:telemetry`.
2. POST /drivers/<id>/location (X-Tenant-ID: berlin) with {lng,lat} -> 202.
3. read-api publishes DriverTelemetryStreamed -> telemetry-streams -> telemetry-worker GEOADDs
   into {tenant:berlin}:drivers:geo.
4. GET /drivers/nearby?lng&lat&radiusKm -> the driver appears (tenant-scoped).

Telemetry is ephemeral (Redis geo only; never persisted to Postgres).
Phase 1d builds the frontends (customer storefront, merchant dashboard, driver GPS emitter, admin grid).
