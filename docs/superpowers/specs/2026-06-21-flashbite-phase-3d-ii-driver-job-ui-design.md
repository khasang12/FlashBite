# Phase 3d-ii — Driver job UI + online toggle (design)

**Goal:** From `apps/web-driver`, a logged-in driver goes online, receives a live dispatch offer, accepts or rejects it, then marks pickup and delivery — driven by real identity (driverId = JWT `sub`) and a dispatch SSE stream.

**Builds on:** Phase 3d-i (dispatch backend: `DriverDispatch` aggregate, `driverDispatchWorkflow` as a child of the order workflow, write-api dispatch command endpoints, read-api online toggle + dispatch reads, `dispatch-events` Avro topic, `dispatches` read model) and Phase 1d-iii (the existing `web-driver` nearby map/table + GPS emitter). Slice **3d-ii** of Phase 3d. The remaining slice **3d-iii** (customer live driver-location tracking) consumes this later.

**Branch:** `phase-3d-ii-driver-job-ui` off `main`.

## Scope

In scope: a read-api dispatch SSE stream (per-driver filtered), identity-seeded driver accounts, and the `web-driver` job UI (online toggle, offer card with countdown, active-job card) plus the web-shared API/hook/helpers behind it.

Out of scope: customer live-location tracking (3d-iii); changing the dispatch workflow, selection logic, or write-api command endpoints (all done in 3d-i); driver earnings/history.

## Architecture & data flow

```
saga dispatch child --(dispatch-events, Avro)--> read-api SSE feeder
   --> DispatchStreamService (per-tenant RxJS Subject of DispatchView)
   --> GET /driver/dispatch/stream  (server-side filter: offeredDriverId|driverId === sub)
   --> useDispatchStream(driverId) hook --> web-driver UI

driver actions --> write-api POST /dispatch/:orderId/{accept,reject,pickup,deliver}  (signals workflow)
online toggle  --> read-api  POST /drivers/:driverId/{online,offline}
```

Identity: the JWT carries `{ sub, tenantId, role }` where `sub` is the Postgres `User.id`. Driver accounts are seeded with explicit ids `drv-1..drv-4`, so `sub === driverId`. The UI reads `driverId` from `claims.sub`; the GPS script (`scripts/stream-gps.sh`) streams those same ids unchanged, and dispatch offers/selects them.

## Backend changes

### 1. Dispatch SSE (read-api)

Mirrors the existing merchant order SSE (`order-stream.service.ts` + `merchant-sse.controller.ts` + `sse-feeder.service.ts`).

- **`DispatchStreamService`** (`apps/read-api/src/sse/dispatch-stream.service.ts`, new): a per-tenant RxJS Subject of `DispatchView` updates. `publish(view)` and `stream(tenantId)` methods, same shape as `OrderStreamService`.
- **`sse-feeder.service.ts`** (modify): in addition to the `order-events` topic, also subscribe to the `dispatch-events` topic. For each decoded dispatch event, derive the current `DispatchView` (status + driverId/offeredDriverId/reason) and call `DispatchStreamService.publish`. Reuse the existing Avro `readEnvelope`/registry path.
- **`GET /driver/dispatch/stream`** (`apps/read-api/src/sse/driver-sse.controller.ts`, new; `@Roles(DRIVER)`): an SSE endpoint that
  1. emits an initial snapshot from the existing `DispatchQueryService.forDriver(tenantId, sub)` (so a reconnecting driver immediately sees their current offer/job), then
  2. subscribes to `DispatchStreamService.stream(tenantId)` and **filters server-side** to events where `offeredDriverId === sub || driverId === sub`.

  `sub` and `tenantId` come from the request auth context (same accessor the dispatch/drivers controllers already use). The merchant SSE controller is the structural template.

### 2. Identity seed (apps/identity)

`apps/identity/src/seed.ts` (modify): for each tenant, create `drv-1@<tenant>.test … drv-4@<tenant>.test`, role `driver`, with explicit `User.id = "drv-1" … "drv-4"` via Prisma `create`/`upsert` (id is settable). Password hash same as other seed users. The pre-existing single `driver@<tenant>.test` may be left in place or removed; this spec removes it to avoid an ambiguous extra driver identity. No token-shape change — `sign({ sub: user.id, ... })` already yields `sub = "drv-N"`.

## web-shared additions (`packages/web-shared`)

- **API client** (`src/api/client.ts`): `goOnline(driverId)`, `goOffline(driverId)`, `acceptDispatch(orderId, driverId)`, `rejectDispatch(orderId, driverId)`, `pickupOrder(orderId, driverId)`, `deliverOrder(orderId, driverId)`, `getDispatchForDriver(driverId)`. All Bearer-authenticated via the existing client wrapper; the four dispatch actions POST `/api/write/dispatch/:orderId/:action` with body `{ driverId }`; online/offline POST `/api/read/drivers/:driverId/:state`; `getDispatchForDriver` GETs `/api/read/driver/dispatch?driverId=...`.
- **`useDispatchStream(driverId)` hook** (`src/hooks/use-dispatch-stream.ts`, new): opens an `EventSource` against `/api/read/driver/dispatch/stream` with the Bearer token (identical connection/auth pattern to `useOrderStream`). Maintains the driver's current `DispatchView | null`, reconciling each pushed event by `orderId` (latest wins). Returns `{ dispatch, connected }`. On error/close it reconnects and re-pulls a snapshot via `getDispatchForDriver`.
- **Helpers + exports** (`src/index.ts`): `dispatchStatusLabel(status)` (OFFERED → "New offer", DISPATCHED → "Accepted — head to pickup", PICKED_UP → "Picked up — deliver", DELIVERED → "Delivered", FAILED → "No longer available"); `DISPATCH_OFFER_TIMEOUT_SECONDS` display constant (mirrors the saga default; display-only — the authoritative timer is server-side); re-export `DispatchView` and `DISPATCH_STATUS` (already re-exported).

## web-driver UI (`apps/web-driver`)

- **Identity** (`app/page.tsx`): read `driverId` from `useAuthStore` `claims.sub`; remove the `DRIVERS`/`useState` selector. The page acts as the logged-in driver.
- **`OnlineToggle`** (`components/online-toggle.tsx`, new): a switch calling `goOnline`/`goOffline`; reflects the current online state (optimistic, reconciled on response). Going offline while holding an active job is allowed (documented simplification — the workflow's delivery timeout still governs).
- **`OfferCard`** (`components/offer-card.tsx`, new): shown when `dispatch.status === OFFERED && dispatch.offeredDriverId === driverId`. Shows order id and a live countdown computed from `dispatch.updatedAt + DISPATCH_OFFER_TIMEOUT_SECONDS`. Accept / Reject buttons call `acceptDispatch` / `rejectDispatch`. On countdown expiry or a superseding event, the card clears.
- **`ActiveJobCard`** (`components/active-job-card.tsx`, new): shown when `dispatch.status ∈ {DISPATCHED, PICKED_UP} && dispatch.driverId === driverId`. DISPATCHED → Pickup button (`pickupOrder`); PICKED_UP → Deliver button (`deliverOrder`); on DELIVERED a brief "Delivered" state then back to idle.
- **Page wiring**: job-first layout — `OnlineToggle` + (`OfferCard` | `ActiveJobCard`) on top, the existing nearby map/table kept below as situational context. The page subscribes via `useDispatchStream(driverId)`.

## Error handling

- **Accept race** (offer already expired or taken by re-offer): the accept POST still returns 202 (it only signals the workflow). The UI reconciles via the stream — if the dispatch does not transition to `DISPATCHED` with `driverId === me`, the offer card clears and the driver waits for the next offer.
- **SSE drop**: the hook auto-reconnects and re-pulls the snapshot via `getDispatchForDriver`, so no offer/job state is lost across a reconnect.
- **Online toggle failure**: surfaced as a non-blocking error on the toggle; state reverts to the last confirmed value.

## Testing

- **Vitest (web-shared)**: the new API fns (URL / method / body / Bearer header) and `dispatchStatusLabel`; a `useDispatchStream` reducer test (a sequence of events → the derived current `DispatchView`).
- **read-api**: a test for the `/driver/dispatch/stream` server-side filter — a driver receives only events where `offeredDriverId|driverId` equals their `sub`, and not other drivers' events. Mirrors the existing `order-stream.spec`.
- **Playwright e2e (`apps/web-driver`)**: full flow against a seeded offer — online → offer appears → accept → pickup → deliver → idle; plus a reject path that clears the offer. Gated like the other web e2e suites.

## Success criteria

1. Logging into `web-driver` as `drv-1@<tenant>.test`, the page acts as driverId `drv-1` (from `sub`), with no driver selector.
2. Toggling online adds `drv-1` to the tenant online set; offline removes it.
3. When the dispatch workflow offers `drv-1`, an offer card appears in real time (via SSE) with a countdown; it appears for no other driver.
4. Accept → active-job card (pickup → deliver); the dispatch read model and order workflow progress to `DELIVERED`.
5. Reject (or countdown expiry) clears the offer; the workflow re-offers to the next-nearest driver.
6. All Vitest, read-api, and (infra-gated) Playwright tests pass; full repo unit sweep + typecheck clean.

## Documentation

Update `docs/ARCHITECTURE.md` §3 (or the driver/dispatch section) to note the dispatch SSE stream and the identity-seeded driver ids; update `apps/web-driver` README/notes if present and the relevant `requests.http` if applicable.

## Known simplifications (backlog)

- Per-tenant SSE subject with server-side per-driver filter (no per-driver topic/partitioning).
- Going offline does not cancel an in-flight job (workflow delivery timeout governs).
- Driver earnings/history, push notifications, and map routing for the active job are out of scope.
