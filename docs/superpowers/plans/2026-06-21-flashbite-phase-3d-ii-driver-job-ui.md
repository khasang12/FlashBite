# Phase 3d-ii — Driver Job UI + Online Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a logged-in driver in `apps/web-driver` go online, receive a live dispatch offer over SSE, accept/reject it, then mark pickup and delivery — with `driverId` derived from the JWT `sub`.

**Architecture:** read-api gains a dispatch SSE stream (a per-tenant RxJS subject fed by a `dispatch-events` Kafka consumer) exposed at `GET /driver/dispatch/stream`, filtered server-side to the authenticated driver. web-shared gains the dispatch API client, a `useDispatchStream` hook, and label/constant helpers. web-driver renders an online toggle + offer card (with countdown) + active-job card on top of the existing nearby map. Identity is made real by seeding `drv-1..drv-4` accounts whose `User.id` equals the driverId.

**Tech Stack:** NestJS 10 + RxJS SSE (read-api), kafkajs + Avro (`@flashbite/messaging`), Prisma/argon2 (identity seed), Next.js 16 + zustand + `@microsoft/fetch-event-source` (web-driver / web-shared), Vitest (web-shared unit), Jest/ts-jest (read-api unit), Playwright (web-driver e2e).

**Branch:** `phase-3d-ii-driver-job-ui` (already created off `main`; the spec is committed there).

---

## File Structure

**read-api**
- Create `apps/read-api/src/sse/dispatch-stream.service.ts` — per-tenant `Subject<DispatchView>` (mirror of `OrderStreamService`).
- Create `apps/read-api/src/sse/driver-sse.controller.ts` — `GET /driver/dispatch/stream`, `@Roles(DRIVER)`, server-side filter to the authenticated `sub`.
- Modify `apps/read-api/src/sse/sse-feeder.service.ts` — also subscribe to `dispatch-events`; add the pure `toDispatchView` mapper.
- Modify `apps/read-api/src/sse/sse.module.ts` — register the new service/controller + deps.
- Modify `apps/read-api/src/tenant-scope.ts` — add `currentSub()`.
- Tests: `apps/read-api/test/dispatch-stream.spec.ts` (new), extend `apps/read-api/test/sse-feeder.spec.ts`.

**identity**
- Modify `apps/identity/src/seed.ts` — seed `drv-1..drv-4@<tenant>.test` with explicit `User.id`.

**web-shared** (`packages/web-shared`)
- Create `src/dispatch/labels.ts` — `dispatchStatusLabel`, `DISPATCH_OFFER_TIMEOUT_SECONDS`.
- Create `src/dispatch/use-dispatch-stream.ts` — `parseDispatchData`, `reduceDispatch`, `useDispatchStream`.
- Modify `src/api/client.ts` — `goOnline/goOffline/acceptDispatch/rejectDispatch/pickupOrder/deliverOrder/getDispatchForDriver`.
- Modify `src/index.ts` — re-export the new types/fns/helpers.
- Tests: `src/dispatch/labels.test.ts`, `src/dispatch/use-dispatch-stream.test.ts`, extend `src/api/client.test.ts`.

**web-driver** (`apps/web-driver`)
- Create `components/online-toggle.tsx`, `components/offer-card.tsx`, `components/active-job-card.tsx`.
- Modify `app/page.tsx` — identity from `sub`, subscribe to `useDispatchStream`, job-first layout.
- Tests: extend `e2e/driver.spec.ts`.

**docs**
- Modify `docs/ARCHITECTURE.md` — note the dispatch SSE stream + identity-seeded driver ids.

---

## Task 1: web-shared — dispatch labels + offer-timeout constant + re-exports

**Files:**
- Create: `packages/web-shared/src/dispatch/labels.ts`
- Create: `packages/web-shared/src/dispatch/labels.test.ts`
- Modify: `packages/web-shared/src/index.ts`

- [ ] **Step 1: Write the failing test**

`packages/web-shared/src/dispatch/labels.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { dispatchStatusLabel, DISPATCH_OFFER_TIMEOUT_SECONDS } from "./labels";

describe("dispatchStatusLabel", () => {
  it("maps each dispatch status to a driver-facing label", () => {
    expect(dispatchStatusLabel("OFFERED")).toBe("New offer");
    expect(dispatchStatusLabel("DISPATCHED")).toBe("Accepted — head to pickup");
    expect(dispatchStatusLabel("PICKED_UP")).toBe("Picked up — deliver");
    expect(dispatchStatusLabel("DELIVERED")).toBe("Delivered");
    expect(dispatchStatusLabel("FAILED")).toBe("No longer available");
  });
  it("falls back to the raw status for an unknown value", () => {
    expect(dispatchStatusLabel("WAT")).toBe("WAT");
  });
});

describe("DISPATCH_OFFER_TIMEOUT_SECONDS", () => {
  it("is the display default matching the saga (30s)", () => {
    expect(DISPATCH_OFFER_TIMEOUT_SECONDS).toBe(30);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flashbite/web-shared test -- labels`
Expected: FAIL — cannot find module `./labels`.

- [ ] **Step 3: Write the implementation**

`packages/web-shared/src/dispatch/labels.ts`:
```ts
import { DISPATCH_STATUS } from "@flashbite/contracts";

/** Display-only mirror of the saga's DISPATCH_OFFER_TIMEOUT_SECONDS default.
 *  The authoritative offer timer lives in the dispatch workflow; this only
 *  drives the UI countdown. */
export const DISPATCH_OFFER_TIMEOUT_SECONDS = 30;

const LABELS: Record<string, string> = {
  [DISPATCH_STATUS.OFFERED]: "New offer",
  [DISPATCH_STATUS.DISPATCHED]: "Accepted — head to pickup",
  [DISPATCH_STATUS.PICKED_UP]: "Picked up — deliver",
  [DISPATCH_STATUS.DELIVERED]: "Delivered",
  [DISPATCH_STATUS.FAILED]: "No longer available",
};

/** Driver-facing label for a dispatch status; unknown values pass through. */
export function dispatchStatusLabel(status: string): string {
  return LABELS[status] ?? status;
}
```

- [ ] **Step 4: Add the re-exports**

In `packages/web-shared/src/index.ts`, after the existing `export { ORDER_STATUS } from "@flashbite/contracts";` line (line 3), add the dispatch contract re-exports:
```ts
export { DISPATCH_STATUS } from "@flashbite/contracts";
export type { DispatchView, DispatchStatus } from "@flashbite/contracts";
```
And near the other helper exports (e.g. after the `StatusPill` export line), add:
```ts
export { dispatchStatusLabel, DISPATCH_OFFER_TIMEOUT_SECONDS } from "./dispatch/labels";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @flashbite/web-shared test -- labels`
Expected: PASS (5 assertions).

- [ ] **Step 6: Commit**

```bash
git add packages/web-shared/src/dispatch/labels.ts packages/web-shared/src/dispatch/labels.test.ts packages/web-shared/src/index.ts
git commit -m "feat(web-shared): dispatch status labels + offer-timeout constant"
```

---

## Task 2: web-shared — dispatch API client functions

**Files:**
- Modify: `packages/web-shared/src/api/client.ts`
- Modify: `packages/web-shared/src/api/client.test.ts`
- Modify: `packages/web-shared/src/index.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/web-shared/src/api/client.test.ts` (inside the `describe("api client", ...)` block; import the new fns at the top of the file alongside the existing imports):
```ts
  it("goOnline POSTs the read online endpoint with Bearer", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ driverId: "drv-1", online: true }), { status: 202 }));
    const res = await goOnline("drv-1");
    expect(res).toEqual({ driverId: "drv-1", online: true });
    expect(lastUrl()).toBe("/api/read/drivers/drv-1/online");
    expect((lastCall()[1] as RequestInit).method).toBe("POST");
    expect(lastHeaders().Authorization).toBe("Bearer test-token");
  });

  it("goOffline POSTs the read offline endpoint", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ driverId: "drv-1", online: false }), { status: 202 }));
    await goOffline("drv-1");
    expect(lastUrl()).toBe("/api/read/drivers/drv-1/offline");
    expect((lastCall()[1] as RequestInit).method).toBe("POST");
  });

  it("acceptDispatch POSTs the write dispatch accept with driverId body", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 202 }));
    await acceptDispatch("o-1", "drv-1");
    expect(lastUrl()).toBe("/api/write/dispatch/o-1/accept");
    expect((lastCall()[1] as RequestInit).method).toBe("POST");
    expect(lastHeaders()["Content-Type"]).toBe("application/json");
    expect(JSON.parse((lastCall()[1] as RequestInit).body as string)).toEqual({ driverId: "drv-1" });
  });

  it("rejectDispatch POSTs the write dispatch reject", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 202 }));
    await rejectDispatch("o-1", "drv-1");
    expect(lastUrl()).toBe("/api/write/dispatch/o-1/reject");
    expect(JSON.parse((lastCall()[1] as RequestInit).body as string)).toEqual({ driverId: "drv-1" });
  });

  it("pickupOrder POSTs the write dispatch pickup", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 202 }));
    await pickupOrder("o-1", "drv-1");
    expect(lastUrl()).toBe("/api/write/dispatch/o-1/pickup");
  });

  it("deliverOrder POSTs the write dispatch deliver", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 202 }));
    await deliverOrder("o-1", "drv-1");
    expect(lastUrl()).toBe("/api/write/dispatch/o-1/deliver");
  });

  it("getDispatchForDriver GETs the driver dispatch read with driverId query", async () => {
    const view = { tenantId: "berlin", orderId: "o-1", status: "OFFERED", offeredDriverId: "drv-1", version: 1, updatedAt: "t" };
    fetchMock.mockResolvedValue(new Response(JSON.stringify(view), { status: 200 }));
    const res = await getDispatchForDriver("drv-1");
    expect(res).toEqual(view);
    expect(lastUrl()).toBe("/api/read/driver/dispatch?driverId=drv-1");
    expect(lastHeaders().Authorization).toBe("Bearer test-token");
  });

  it("getDispatchForDriver passes through { status: null }", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ status: null }), { status: 200 }));
    expect(await getDispatchForDriver("drv-1")).toEqual({ status: null });
  });
```
Add to the import list at the top of `client.test.ts`:
```ts
  goOnline, goOffline, acceptDispatch, rejectDispatch, pickupOrder, deliverOrder, getDispatchForDriver,
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @flashbite/web-shared test -- client`
Expected: FAIL — the new functions are not exported from `./client`.

- [ ] **Step 3: Write the implementation**

Append to `packages/web-shared/src/api/client.ts` (and add `DispatchView` to the type import on line 1: `import type { OrderItem, OrderView, OrderPaymentView, DispatchView } from "@flashbite/contracts";`):
```ts
// --- Driver dispatch (3d-ii) ---

/** POST /drivers/:id/online — add the driver to the tenant online set (read-api). */
export async function goOnline(driverId: string): Promise<{ driverId: string; online: boolean }> {
  const res = await authedFetch(`/api/read/drivers/${encodeURIComponent(driverId)}/online`, { method: "POST" });
  if (!res.ok) throw new Error(`goOnline failed: ${res.status}`);
  return (await res.json()) as { driverId: string; online: boolean };
}

/** POST /drivers/:id/offline — remove the driver from the tenant online set (read-api). */
export async function goOffline(driverId: string): Promise<{ driverId: string; online: boolean }> {
  const res = await authedFetch(`/api/read/drivers/${encodeURIComponent(driverId)}/offline`, { method: "POST" });
  if (!res.ok) throw new Error(`goOffline failed: ${res.status}`);
  return (await res.json()) as { driverId: string; online: boolean };
}

/** POST /dispatch/:orderId/:action {driverId} — signal the dispatch child workflow (write-api). */
async function signalDispatch(orderId: string, action: "accept" | "reject" | "pickup" | "deliver", driverId: string): Promise<void> {
  const res = await authedFetch(`/api/write/dispatch/${encodeURIComponent(orderId)}/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ driverId }),
  });
  if (!res.ok) throw new Error(`${action}Dispatch failed: ${res.status}`);
}

export function acceptDispatch(orderId: string, driverId: string): Promise<void> {
  return signalDispatch(orderId, "accept", driverId);
}
export function rejectDispatch(orderId: string, driverId: string): Promise<void> {
  return signalDispatch(orderId, "reject", driverId);
}
export function pickupOrder(orderId: string, driverId: string): Promise<void> {
  return signalDispatch(orderId, "pickup", driverId);
}
export function deliverOrder(orderId: string, driverId: string): Promise<void> {
  return signalDispatch(orderId, "deliver", driverId);
}

/** GET /driver/dispatch?driverId=... — the driver's current offer/active job (read-api). */
export async function getDispatchForDriver(driverId: string): Promise<DispatchView | { status: null }> {
  const qs = new URLSearchParams({ driverId });
  const res = await authedFetch(`/api/read/driver/dispatch?${qs.toString()}`);
  if (!res.ok) throw new Error(`getDispatchForDriver failed: ${res.status}`);
  return (await res.json()) as DispatchView | { status: null };
}
```

- [ ] **Step 4: Add the exports**

In `packages/web-shared/src/index.ts`, extend the existing client re-export block (the one exporting `reportLocation, getNearbyDrivers, ...`) to also include:
```ts
  goOnline, goOffline, acceptDispatch, rejectDispatch, pickupOrder, deliverOrder, getDispatchForDriver,
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @flashbite/web-shared test -- client`
Expected: PASS (existing + 8 new assertions).

- [ ] **Step 6: Commit**

```bash
git add packages/web-shared/src/api/client.ts packages/web-shared/src/api/client.test.ts packages/web-shared/src/index.ts
git commit -m "feat(web-shared): driver dispatch API client (online/accept/reject/pickup/deliver)"
```

---

## Task 3: web-shared — useDispatchStream hook (parser + reducer + SSE)

**Files:**
- Create: `packages/web-shared/src/dispatch/use-dispatch-stream.ts`
- Create: `packages/web-shared/src/dispatch/use-dispatch-stream.test.ts`
- Modify: `packages/web-shared/src/index.ts`

- [ ] **Step 1: Write the failing tests**

`packages/web-shared/src/dispatch/use-dispatch-stream.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { parseDispatchData, reduceDispatch } from "./use-dispatch-stream";
import type { DispatchView } from "@flashbite/contracts";

const view = (over: Partial<DispatchView> = {}): DispatchView => ({
  tenantId: "berlin", orderId: "o-1", status: "OFFERED", offeredDriverId: "drv-1", version: 1, updatedAt: "t1", ...over,
});

describe("parseDispatchData", () => {
  it("parses a well-formed dispatch view", () => {
    expect(parseDispatchData(JSON.stringify(view()))).toEqual(view());
  });
  it("returns null for malformed JSON", () => {
    expect(parseDispatchData("nope")).toBeNull();
  });
  it("returns null when orderId or status is missing", () => {
    expect(parseDispatchData(JSON.stringify({ orderId: "o-1" }))).toBeNull();
    expect(parseDispatchData(JSON.stringify({ status: "OFFERED" }))).toBeNull();
  });
});

describe("reduceDispatch", () => {
  it("takes the incoming view when there is none", () => {
    expect(reduceDispatch(null, view())).toEqual(view());
  });
  it("advances to a newer version of the same order", () => {
    const next = view({ status: "DISPATCHED", driverId: "drv-1", version: 2, updatedAt: "t2" });
    expect(reduceDispatch(view(), next)).toEqual(next);
  });
  it("ignores a stale (older-version) event for the same order", () => {
    const prev = view({ status: "DISPATCHED", version: 2 });
    expect(reduceDispatch(prev, view({ version: 1 }))).toEqual(prev);
  });
  it("switches to a different order regardless of version", () => {
    const other = view({ orderId: "o-2", version: 1 });
    expect(reduceDispatch(view({ version: 5 }), other)).toEqual(other);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @flashbite/web-shared test -- use-dispatch-stream`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`packages/web-shared/src/dispatch/use-dispatch-stream.ts`:
```ts
"use client";
import { useEffect, useRef, useState } from "react";
import { fetchEventSource } from "@microsoft/fetch-event-source";
import type { DispatchView } from "@flashbite/contracts";
import { useAuthStore } from "../store/auth-store";

/** Pure parser for one SSE `data` payload into a DispatchView. Exported for tests. */
export function parseDispatchData(data: string): DispatchView | null {
  try {
    const o = JSON.parse(data) as Partial<DispatchView>;
    if (typeof o.orderId === "string" && typeof o.status === "string") return o as DispatchView;
    return null;
  } catch {
    return null;
  }
}

/** Reconcile the current dispatch view with an incoming one: a different order
 *  always wins; the same order only advances on a newer version. Exported for tests. */
export function reduceDispatch(prev: DispatchView | null, next: DispatchView): DispatchView {
  if (!prev || prev.orderId !== next.orderId) return next;
  return next.version >= prev.version ? next : prev;
}

/**
 * Subscribes to the driver dispatch SSE stream via the same-origin read proxy.
 * Fetch-based SSE so the Authorization header is sent. Returns the driver's
 * current dispatch view (offer or active job) and the connection state.
 */
export function useDispatchStream(driverId: string | undefined): { dispatch: DispatchView | null; connected: boolean } {
  const [dispatch, setDispatch] = useState<DispatchView | null>(null);
  const [connected, setConnected] = useState(false);
  const token = useAuthStore((s) => s.token);

  useEffect(() => {
    if (!token || !driverId) return;
    const ctrl = new AbortController();
    void fetchEventSource("/api/read/driver/dispatch/stream", {
      headers: { Authorization: `Bearer ${token}` },
      signal: ctrl.signal,
      openWhenHidden: true,
      onopen: async (response: Response) => {
        if (response.status === 401) {
          useAuthStore.getState().logout();
          throw new Error("unauthorized");
        }
        setConnected(true);
      },
      onmessage: (msg) => {
        const view = parseDispatchData(msg.data);
        if (view) setDispatch((prev) => reduceDispatch(prev, view));
      },
      onerror: () => { setConnected(false); /* let fetchEventSource retry */ },
    }).catch(() => { /* aborted on unmount */ });
    return () => { ctrl.abort(); setConnected(false); };
  }, [token, driverId]);

  return { dispatch, connected };
}
```

- [ ] **Step 4: Add the export**

In `packages/web-shared/src/index.ts`, after the `dispatchStatusLabel` export added in Task 1, add:
```ts
export { useDispatchStream, parseDispatchData, reduceDispatch } from "./dispatch/use-dispatch-stream";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @flashbite/web-shared test -- use-dispatch-stream`
Expected: PASS (7 assertions).

- [ ] **Step 6: Commit**

```bash
git add packages/web-shared/src/dispatch/use-dispatch-stream.ts packages/web-shared/src/dispatch/use-dispatch-stream.test.ts packages/web-shared/src/index.ts
git commit -m "feat(web-shared): useDispatchStream hook (SSE + pure parser/reducer)"
```

---

## Task 4: read-api — DispatchStreamService + feeder consumes dispatch-events

**Files:**
- Create: `apps/read-api/src/sse/dispatch-stream.service.ts`
- Modify: `apps/read-api/src/sse/sse-feeder.service.ts`
- Test: `apps/read-api/test/dispatch-stream.spec.ts` (new), `apps/read-api/test/sse-feeder.spec.ts` (extend)

- [ ] **Step 1: Write the failing tests**

`apps/read-api/test/dispatch-stream.spec.ts`:
```ts
import { firstValueFrom } from "rxjs";
import { take, toArray } from "rxjs/operators";
import { DispatchStreamService } from "../src/sse/dispatch-stream.service";
import type { DispatchView } from "@flashbite/contracts";

const view = (over: Partial<DispatchView> = {}): DispatchView => ({
  tenantId: "berlin", orderId: "o-1", status: "OFFERED", offeredDriverId: "drv-1", version: 1, updatedAt: "t", ...over,
});

describe("DispatchStreamService", () => {
  it("delivers published views to a tenant subscriber", async () => {
    const svc = new DispatchStreamService();
    const collected = firstValueFrom(svc.stream("berlin").pipe(take(2), toArray()));
    svc.publish("berlin", view());
    svc.publish("berlin", view({ status: "DISPATCHED", driverId: "drv-1", version: 2 }));
    const got = await collected;
    expect(got.map((v) => v.status)).toEqual(["OFFERED", "DISPATCHED"]);
  });

  it("isolates tenants — a berlin subscriber never sees tokyo events", async () => {
    const svc = new DispatchStreamService();
    const berlin: DispatchView[] = [];
    svc.stream("berlin").subscribe((v) => berlin.push(v));
    svc.publish("tokyo", view({ tenantId: "tokyo" }));
    expect(berlin).toEqual([]);
  });
});
```

Append to `apps/read-api/test/sse-feeder.spec.ts` (import `toDispatchView` from the feeder, and build envelopes with the existing helper style in that file):
```ts
import { toDispatchView } from "../src/sse/sse-feeder.service";
import { EVENT_TYPES } from "@flashbite/contracts";

describe("toDispatchView", () => {
  const base = { tenantId: "berlin", version: 3, occurredAt: "2026-06-21T00:00:00.000Z" };
  it("maps DriverOffered -> OFFERED with offeredDriverId", () => {
    const v = toDispatchView({ ...base, eventType: EVENT_TYPES.DRIVER_OFFERED, payload: { orderId: "o-1", driverId: "drv-1" } } as never);
    expect(v).toMatchObject({ orderId: "o-1", status: "OFFERED", offeredDriverId: "drv-1", version: 3 });
  });
  it("maps DispatchAccepted -> DISPATCHED with driverId", () => {
    const v = toDispatchView({ ...base, eventType: EVENT_TYPES.DISPATCH_ACCEPTED, payload: { orderId: "o-1", driverId: "drv-1" } } as never);
    expect(v).toMatchObject({ status: "DISPATCHED", driverId: "drv-1" });
  });
  it("maps OrderPickedUp/OrderDelivered -> PICKED_UP/DELIVERED", () => {
    expect(toDispatchView({ ...base, eventType: EVENT_TYPES.ORDER_PICKED_UP, payload: { orderId: "o-1" } } as never)?.status).toBe("PICKED_UP");
    expect(toDispatchView({ ...base, eventType: EVENT_TYPES.ORDER_DELIVERED, payload: { orderId: "o-1" } } as never)?.status).toBe("DELIVERED");
  });
  it("maps DispatchFailed -> FAILED with reason", () => {
    const v = toDispatchView({ ...base, eventType: EVENT_TYPES.DISPATCH_FAILED, payload: { orderId: "o-1", reason: "NO_DRIVERS_AVAILABLE" } } as never);
    expect(v).toMatchObject({ status: "FAILED", reason: "NO_DRIVERS_AVAILABLE" });
  });
  it("returns null for an unrelated event type", () => {
    expect(toDispatchView({ ...base, eventType: "OrderPlaced", payload: { orderId: "o-1" } } as never)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm jest apps/read-api/test/dispatch-stream.spec.ts apps/read-api/test/sse-feeder.spec.ts`
Expected: FAIL — `DispatchStreamService` / `toDispatchView` not found.

- [ ] **Step 3: Write DispatchStreamService**

`apps/read-api/src/sse/dispatch-stream.service.ts`:
```ts
import { Injectable } from "@nestjs/common";
import { Observable, Subject } from "rxjs";
import type { DispatchView } from "@flashbite/contracts";

@Injectable()
export class DispatchStreamService {
  private readonly subjects = new Map<string, Subject<DispatchView>>();

  private subjectFor(tenantId: string): Subject<DispatchView> {
    let s = this.subjects.get(tenantId);
    if (!s) {
      s = new Subject<DispatchView>();
      this.subjects.set(tenantId, s);
    }
    return s;
  }

  publish(tenantId: string, view: DispatchView): void {
    this.subjectFor(tenantId).next(view);
  }

  stream(tenantId: string): Observable<DispatchView> {
    return this.subjectFor(tenantId).asObservable();
  }
}
```

- [ ] **Step 4: Extend the feeder to consume dispatch-events**

Modify `apps/read-api/src/sse/sse-feeder.service.ts`. Add the imports and the `toDispatchView` mapper, inject `DispatchStreamService`, subscribe to the dispatch topic, and branch by topic in `eachMessage`:

```ts
// add to the contracts import:
import {
  CONSUMER_GROUPS, EVENT_TYPES, ORDER_STATUS, TOPICS, DISPATCH_STATUS,
  type EventEnvelope, type OrderPlacedPayload, type DispatchView,
  type DriverOfferedPayload, type DispatchAcceptedPayload, type DispatchFailedPayload,
} from "@flashbite/contracts";
import { DispatchStreamService } from "./dispatch-stream.service";

/** Maps a dispatch-events envelope to a DispatchView; null for unrelated events.
 *  Mirrors applyDispatchEvent in the projection worker. */
export function toDispatchView(envelope: EventEnvelope): DispatchView | null {
  const orderId = (envelope.payload as { orderId: string }).orderId;
  const base = { tenantId: envelope.tenantId, orderId, version: envelope.version, updatedAt: envelope.occurredAt };
  switch (envelope.eventType) {
    case EVENT_TYPES.DRIVER_OFFERED:
      return { ...base, status: DISPATCH_STATUS.OFFERED, offeredDriverId: (envelope.payload as DriverOfferedPayload).driverId };
    case EVENT_TYPES.DISPATCH_ACCEPTED:
      return { ...base, status: DISPATCH_STATUS.DISPATCHED, driverId: (envelope.payload as DispatchAcceptedPayload).driverId };
    case EVENT_TYPES.ORDER_PICKED_UP:
      return { ...base, status: DISPATCH_STATUS.PICKED_UP };
    case EVENT_TYPES.ORDER_DELIVERED:
      return { ...base, status: DISPATCH_STATUS.DELIVERED };
    case EVENT_TYPES.DISPATCH_FAILED:
      return { ...base, status: DISPATCH_STATUS.FAILED, reason: (envelope.payload as DispatchFailedPayload).reason };
    default:
      return null;
  }
}
```

Change the constructor to inject both services:
```ts
  constructor(
    private readonly stream: OrderStreamService,
    private readonly dispatchStream: DispatchStreamService,
  ) {}
```

In `onModuleInit`, after the existing `await this.consumer.subscribe({ topic: TOPICS.ORDER_EVENTS, fromBeginning: false });`, add:
```ts
    await this.consumer.subscribe({ topic: TOPICS.DISPATCH_EVENTS, fromBeginning: false });
```

Replace the `eachMessage` handler body to branch by topic:
```ts
    await this.consumer.run({
      eachMessage: async ({ topic, message }) => {
        const envelope = await readEnvelope(registry, message);
        if (!envelope) return;
        if (topic === TOPICS.DISPATCH_EVENTS) {
          const view = toDispatchView(envelope);
          if (view) this.dispatchStream.publish(envelope.tenantId, view);
          return;
        }
        this.stream.publish(envelope.tenantId, toStreamEvent(envelope));
      },
    });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm jest apps/read-api/test/dispatch-stream.spec.ts apps/read-api/test/sse-feeder.spec.ts`
Expected: PASS (DispatchStreamService 2 + toDispatchView 5).

- [ ] **Step 6: Commit**

```bash
git add apps/read-api/src/sse/dispatch-stream.service.ts apps/read-api/src/sse/sse-feeder.service.ts apps/read-api/test/dispatch-stream.spec.ts apps/read-api/test/sse-feeder.spec.ts
git commit -m "feat(read-api): dispatch SSE stream service + feeder consumes dispatch-events"
```

---

## Task 5: read-api — GET /driver/dispatch/stream (server-side per-driver filter)

**Files:**
- Create: `apps/read-api/src/sse/driver-sse.controller.ts`
- Modify: `apps/read-api/src/tenant-scope.ts`
- Modify: `apps/read-api/src/sse/sse.module.ts`
- Test: `apps/read-api/test/dispatch-stream.spec.ts` (extend with the filter predicate)

- [ ] **Step 1: Write the failing test**

Append to `apps/read-api/test/dispatch-stream.spec.ts`:
```ts
import { isForDriver } from "../src/sse/driver-sse.controller";

describe("isForDriver", () => {
  it("matches an offer targeted at the driver", () => {
    expect(isForDriver(view({ status: "OFFERED", offeredDriverId: "drv-1" }), "drv-1")).toBe(true);
  });
  it("matches an active job assigned to the driver", () => {
    expect(isForDriver(view({ status: "DISPATCHED", driverId: "drv-1", offeredDriverId: undefined }), "drv-1")).toBe(true);
  });
  it("rejects another driver's offer/job", () => {
    expect(isForDriver(view({ status: "OFFERED", offeredDriverId: "drv-2" }), "drv-1")).toBe(false);
    expect(isForDriver(view({ status: "DISPATCHED", driverId: "drv-2", offeredDriverId: undefined }), "drv-1")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm jest apps/read-api/test/dispatch-stream.spec.ts`
Expected: FAIL — `isForDriver` not found.

- [ ] **Step 3: Add `currentSub` to tenant-scope**

In `apps/read-api/src/tenant-scope.ts`, change the import line to also pull `getAuthContext`:
```ts
import { getTenantId, getAuthContext } from "@flashbite/tenant-context";
```
and add:
```ts
/** The current request's authenticated subject (driverId for driver tokens). */
export const currentSub = (): string => getAuthContext().sub;
```

- [ ] **Step 4: Write the driver SSE controller**

`apps/read-api/src/sse/driver-sse.controller.ts`:
```ts
import { Controller, Sse, UseGuards } from "@nestjs/common";
import { Observable, concat, defer, from } from "rxjs";
import { filter, map } from "rxjs/operators";
import { Roles, RolesGuard } from "@flashbite/tenant-context";
import { ROLES, type DispatchView } from "@flashbite/contracts";
import { currentTenant, currentSub } from "../tenant-scope";
import { DispatchQueryService } from "../dispatch/dispatch-query.service";
import { DispatchStreamService } from "./dispatch-stream.service";

interface MessageEvent {
  data: unknown;
}

/** True when a dispatch view concerns this driver — either an offer made to them
 *  or an active job assigned to them. Exported for tests. */
export function isForDriver(view: DispatchView, driverId: string): boolean {
  return view.offeredDriverId === driverId || view.driverId === driverId;
}

@Controller()
@UseGuards(RolesGuard)
export class DriverSseController {
  constructor(
    private readonly dispatch: DispatchQueryService,
    private readonly stream: DispatchStreamService,
  ) {}

  @Sse("driver/dispatch/stream")
  @Roles(ROLES.DRIVER)
  driverStream(): Observable<MessageEvent> {
    const tenantId = currentTenant();
    const driverId = currentSub();
    // Initial snapshot (current offer/job, if any) then the live, per-driver-filtered tail.
    const snapshot$ = defer(async () => this.dispatch.forDriver(tenantId, driverId)).pipe(
      filter((v): v is DispatchView => v != null),
    );
    const live$ = this.stream.stream(tenantId).pipe(filter((v) => isForDriver(v, driverId)));
    return concat(snapshot$, live$).pipe(map((view) => ({ data: view })));
  }
}
```
(`defer(async () => ...)` yields a Promise the RxJS `from`/`defer` resolves; `concat` emits the snapshot first, then the live stream.)

- [ ] **Step 5: Wire the SSE module**

Modify `apps/read-api/src/sse/sse.module.ts`:
```ts
import { Module } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { MongoService } from "@flashbite/shared";
import { RolesGuard } from "@flashbite/tenant-context";
import { OrderStreamService } from "./order-stream.service";
import { DispatchStreamService } from "./dispatch-stream.service";
import { SseFeederService } from "./sse-feeder.service";
import { MerchantSseController } from "./merchant-sse.controller";
import { DriverSseController } from "./driver-sse.controller";
import { DispatchQueryService } from "../dispatch/dispatch-query.service";

@Module({
  controllers: [MerchantSseController, DriverSseController],
  providers: [
    OrderStreamService,
    DispatchStreamService,
    SseFeederService,
    DispatchQueryService,
    MongoService,
    RolesGuard,
    Reflector,
  ],
  exports: [OrderStreamService, DispatchStreamService],
})
export class SseModule {}
```

- [ ] **Step 6: Run test + typecheck**

Run: `pnpm jest apps/read-api/test/dispatch-stream.spec.ts`
Expected: PASS (filter predicate 4 assertions + earlier service/mapper tests).
Run: `npx tsc --noEmit -p apps/read-api/tsconfig.json`
Expected: EXIT 0.

- [ ] **Step 7: Commit**

```bash
git add apps/read-api/src/sse/driver-sse.controller.ts apps/read-api/src/sse/sse.module.ts apps/read-api/src/tenant-scope.ts apps/read-api/test/dispatch-stream.spec.ts
git commit -m "feat(read-api): GET /driver/dispatch/stream filtered to the authenticated driver"
```

---

## Task 6: identity — seed stable driver accounts (drv-1..drv-4)

**Files:**
- Modify: `apps/identity/src/seed.ts`
- Modify: `apps/web-driver/app/page.tsx` (demo user list only; full wiring in Task 8)

Design note (read first): `User.id` is a **global** primary key, so the same `drv-1` cannot exist in two tenants. The dispatch demo (GPS script, `CITY_CENTERS`, selection) runs per tenant, and the existing GPS script streams the clean ids `drv-1..drv-4`. Scheme: keep the clean ids in `berlin` (`id = "drv-1"`) and tenant-suffix elsewhere (`id = "drv-1-tokyo"`). The driver UI always uses `sub`, so it is tenant-agnostic. A previously-seeded `driver@<tenant>.test` row has a different email and is left untouched (harmless, unused).

- [ ] **Step 1: Update the seed**

In `apps/identity/src/seed.ts`, drop `ROLES.DRIVER` from `SEED_ROLES` (drivers are seeded explicitly with stable ids) and add a `DRIVER_IDS` list. Replace line 6:
```ts
const SEED_ROLES = [ROLES.CUSTOMER, ROLES.MERCHANT, ROLES.DRIVER, ROLES.ADMIN] as const;
```
with:
```ts
const SEED_ROLES = [ROLES.CUSTOMER, ROLES.MERCHANT, ROLES.ADMIN] as const;
const DRIVER_IDS = ["drv-1", "drv-2", "drv-3", "drv-4"] as const;
```
Then, inside the `for (const tenantId of TENANTS)` loop, after the inner `for (const role of SEED_ROLES)` loop, add the driver loop:
```ts
      // Drivers get stable ids so the JWT sub IS the dispatch driverId. User.id is a
      // global PK, so keep clean ids in berlin and tenant-suffix the rest.
      for (const driverId of DRIVER_IDS) {
        const id = tenantId === "berlin" ? driverId : `${driverId}-${tenantId}`;
        const email = `${driverId}@${tenantId}.test`;
        await prisma.user.upsert({
          where: { email },
          update: { id, tenantId, role: ROLES.DRIVER, passwordHash },
          create: { id, tenantId, role: ROLES.DRIVER, email, passwordHash },
        });
        // eslint-disable-next-line no-console
        console.log(`seeded ${email} (${tenantId}/${ROLES.DRIVER}, id=${id})`);
      }
```

- [ ] **Step 2: Update the driver demo-user quick-picks**

In `apps/web-driver/app/page.tsx`, replace the `DRIVER_DEMOS` array so login uses the seeded driver accounts (full page wiring is Task 8; this keeps the e2e quick-pick working):
```ts
const DRIVER_DEMOS = [
  { label: "Berlin drv-1", email: "drv-1@berlin.test" },
  { label: "Berlin drv-2", email: "drv-2@berlin.test" },
  { label: "Tokyo drv-1", email: "drv-1@tokyo.test" },
];
```

- [ ] **Step 3: Re-run the seed and verify**

Run: `pnpm seed:users`
Expected: console lines including `seeded drv-1@berlin.test (berlin/driver, id=drv-1)` … `drv-4`, and `drv-1@tokyo.test (tokyo/driver, id=drv-1-tokyo)`.

Verify a token's `sub`:
```bash
curl -s localhost:3003/auth/login -H 'content-type: application/json' \
  -d '{"email":"drv-1@berlin.test","password":"devpassword"}' | \
  python3 -c "import sys,json,base64; t=json.load(sys.stdin)['accessToken']; p=t.split('.')[1]; print(json.loads(base64.urlsafe_b64decode(p+'==')))"
```
Expected: `{'tenantId': 'berlin', 'role': 'driver', 'sub': 'drv-1', ...}`.

- [ ] **Step 4: Commit**

```bash
git add apps/identity/src/seed.ts apps/web-driver/app/page.tsx
git commit -m "feat(identity): seed stable driver ids (sub == driverId) for dispatch"
```

---

## Task 7: web-driver — OnlineToggle, OfferCard, ActiveJobCard components

**Files:**
- Create: `apps/web-driver/components/online-toggle.tsx`
- Create: `apps/web-driver/components/offer-card.tsx`
- Create: `apps/web-driver/components/active-job-card.tsx`

(web-driver has no unit harness; these are verified by build/typecheck here and by the Playwright e2e in Task 9.)

- [ ] **Step 1: OnlineToggle**

`apps/web-driver/components/online-toggle.tsx`:
```tsx
"use client";
import { useState } from "react";
import { Button, goOnline, goOffline } from "@flashbite/web-shared";

export function OnlineToggle({ driverId, online, onChange }: { driverId: string; online: boolean; onChange: (online: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    setBusy(true);
    setError(null);
    const next = !online;
    try {
      if (next) await goOnline(driverId); else await goOffline(driverId);
      onChange(next);
    } catch {
      setError("Could not update status");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-3 text-sm font-semibold">
      <span className={online ? "text-primary" : "text-muted-foreground"}>
        {online ? "Online" : "Offline"}
      </span>
      <Button variant={online ? "secondary" : "default"} onClick={toggle} disabled={busy} aria-pressed={online}>
        {online ? "Go offline" : "Go online"}
      </Button>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}
```

- [ ] **Step 2: OfferCard (with countdown)**

`apps/web-driver/components/offer-card.tsx`:
```tsx
"use client";
import { useEffect, useState } from "react";
import { Button, DISPATCH_OFFER_TIMEOUT_SECONDS, type DispatchView } from "@flashbite/web-shared";

function secondsLeft(updatedAt: string): number {
  const elapsed = (Date.now() - Date.parse(updatedAt)) / 1000;
  return Math.max(0, Math.ceil(DISPATCH_OFFER_TIMEOUT_SECONDS - elapsed));
}

export function OfferCard({ offer, onAccept, onReject, onExpire }: {
  offer: DispatchView;
  onAccept: () => void;
  onReject: () => void;
  onExpire: () => void;
}) {
  const [left, setLeft] = useState(() => secondsLeft(offer.updatedAt));

  useEffect(() => {
    setLeft(secondsLeft(offer.updatedAt));
    const t = setInterval(() => {
      const s = secondsLeft(offer.updatedAt);
      setLeft(s);
      if (s <= 0) onExpire();
    }, 1000);
    return () => clearInterval(t);
  }, [offer.updatedAt, offer.orderId, onExpire]);

  return (
    <div className="rounded-xl border border-primary/40 bg-primary/5 px-5 py-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="font-bold">New delivery offer</div>
          <div className="text-xs text-muted-foreground">order {offer.orderId} · expires in {left}s</div>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onReject}>Decline</Button>
          <Button onClick={onAccept}>Accept</Button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: ActiveJobCard**

`apps/web-driver/components/active-job-card.tsx`:
```tsx
"use client";
import { Button, DISPATCH_STATUS, dispatchStatusLabel, type DispatchView } from "@flashbite/web-shared";

export function ActiveJobCard({ job, onPickup, onDeliver }: {
  job: DispatchView;
  onPickup: () => void;
  onDeliver: () => void;
}) {
  return (
    <div className="rounded-xl border px-5 py-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="font-bold">{dispatchStatusLabel(job.status)}</div>
          <div className="text-xs text-muted-foreground">order {job.orderId}</div>
        </div>
        <div className="flex gap-2">
          {job.status === DISPATCH_STATUS.DISPATCHED && <Button onClick={onPickup}>Mark picked up</Button>}
          {job.status === DISPATCH_STATUS.PICKED_UP && <Button onClick={onDeliver}>Mark delivered</Button>}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter web-driver exec tsc --noEmit`
Expected: EXIT 0 (components compile; they're imported in Task 8).

If `web-driver` has no standalone `tsc` script, instead verify in Task 8 via `pnpm --filter web-driver build`. Do not commit dead components alone — proceed to Task 8 and commit together if typecheck can't run in isolation. If isolated typecheck works, commit:

```bash
git add apps/web-driver/components/online-toggle.tsx apps/web-driver/components/offer-card.tsx apps/web-driver/components/active-job-card.tsx
git commit -m "feat(web-driver): online toggle + offer card (countdown) + active-job card"
```

---

## Task 8: web-driver — page wiring (identity, dispatch stream, job-first layout)

**Files:**
- Modify: `apps/web-driver/app/page.tsx`

- [ ] **Step 1: Rewrite the page to use identity + the dispatch stream**

Replace `apps/web-driver/app/page.tsx` with (keeps the existing nearby map/table as context, adds the job surface, removes the `drv-1..drv-4` selector and `DRIVERS`):
```tsx
"use client";
import { useCallback, useState } from "react";
import {
  AuthGate, useAuthStore,
  type Tenant, type DispatchView,
  CITY_CENTERS, toNearbyRows,
  Button,
  DISPATCH_STATUS,
  useDispatchStream,
  acceptDispatch, rejectDispatch, pickupOrder, deliverOrder,
} from "@flashbite/web-shared";
import { useNearbyWatch } from "@/hooks/use-nearby-watch";
import { NearbyMap } from "@/components/nearby-map";
import { NearbyTable } from "@/components/nearby-table";
import { OnlineToggle } from "@/components/online-toggle";
import { OfferCard } from "@/components/offer-card";
import { ActiveJobCard } from "@/components/active-job-card";

const DRIVER_DEMOS = [
  { label: "Berlin drv-1", email: "drv-1@berlin.test" },
  { label: "Berlin drv-2", email: "drv-2@berlin.test" },
  { label: "Tokyo drv-1", email: "drv-1@tokyo.test" },
];

function DriverDashboard() {
  const tenantId = (useAuthStore((s) => s.claims?.tenantId) ?? "berlin") as Tenant;
  const driverId = useAuthStore((s) => s.claims?.sub) ?? "";
  const [online, setOnline] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);

  const { dispatch, connected } = useDispatchStream(driverId);
  // An offer the driver hasn't dismissed (rejected/expired) locally.
  const offer: DispatchView | null =
    dispatch && dispatch.status === DISPATCH_STATUS.OFFERED && dispatch.offeredDriverId === driverId && dispatch.orderId !== dismissed
      ? dispatch
      : null;
  const job: DispatchView | null =
    dispatch && (dispatch.status === DISPATCH_STATUS.DISPATCHED || dispatch.status === DISPATCH_STATUS.PICKED_UP) && dispatch.driverId === driverId
      ? dispatch
      : null;

  const center = CITY_CENTERS[tenantId];
  const { nearby } = useNearbyWatch(center, online);
  const self = nearby.find((d) => d.driverId === driverId) ?? null;
  const others = toNearbyRows(nearby, driverId);
  const mapCenter = self ? { lng: self.lng, lat: self.lat } : center;

  const onExpire = useCallback(() => { if (offer) setDismissed(offer.orderId); }, [offer]);

  return (
    <div className="min-h-screen bg-background">
      <header className="flex items-center justify-between border-b px-6 py-4">
        <div className="text-lg font-extrabold">
          flashbite <span className="text-muted-foreground font-semibold">driver</span>
        </div>
        <div className="flex items-center gap-3 text-sm font-semibold">
          <span className="text-muted-foreground">{driverId}</span>
          <OnlineToggle driverId={driverId} online={online} onChange={setOnline} />
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-6 space-y-6">
        {offer && (
          <OfferCard
            offer={offer}
            onAccept={() => { void acceptDispatch(offer.orderId, driverId); }}
            onReject={() => { setDismissed(offer.orderId); void rejectDispatch(offer.orderId, driverId); }}
            onExpire={onExpire}
          />
        )}
        {job && (
          <ActiveJobCard
            job={job}
            onPickup={() => { void pickupOrder(job.orderId, driverId); }}
            onDeliver={() => { void deliverOrder(job.orderId, driverId); }}
          />
        )}
        {!offer && !job && (
          <div className="rounded-xl border px-5 py-4 text-sm text-muted-foreground">
            {online
              ? `Online${connected ? "" : " · connecting…"} — waiting for an offer.`
              : "You're offline. Go online to receive delivery offers."}
          </div>
        )}

        {online && (
          <div className="grid gap-6 md:grid-cols-[2fr_1fr]">
            <section>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Nearby · 5km radius
              </div>
              <NearbyMap center={mapCenter} self={self} nearby={others} />
            </section>
            <section>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Nearby drivers ({others.length})
              </div>
              <NearbyTable data={others} />
            </section>
          </div>
        )}
      </main>
    </div>
  );
}

export default function DriverPage() {
  return (
    <AuthGate demoUsers={DRIVER_DEMOS} requiredRole="driver" title="FlashBite — Driver">
      <DriverDashboard />
    </AuthGate>
  );
}
```

Notes for the implementer:
- `useNearbyWatch(center, online)` reuses the existing hook; we drive it off `online` instead of the removed `watching` state.
- The `Button` import may now be unused if no other button remains in the page; remove it from the import if `tsc`/eslint flags it.

- [ ] **Step 2: Build to verify**

Run: `pnpm --filter web-driver build`
Expected: build succeeds (Next.js compiles the page + new components).

- [ ] **Step 3: Commit**

```bash
git add apps/web-driver/app/page.tsx
git commit -m "feat(web-driver): job-first dashboard — identity from sub + live dispatch stream"
```

---

## Task 9: web-driver Playwright e2e + docs + full verification

**Files:**
- Modify: `apps/web-driver/e2e/driver.spec.ts`
- Modify: `docs/ARCHITECTURE.md`

- [ ] **Step 1: Update the existing e2e for the new layout**

The first existing test asserts the old "Not watching…" copy, which is gone. Replace the two existing tests' driver labels (`"Berlin driver"` → `"Berlin drv-1"`) and the offline-state assertion. Replace the file body's tests with:
```ts
import { test, expect } from "@playwright/test";
import { loginViaUI } from "./auth";

test("offline by default — prompts to go online, no nearby section", async ({ page }) => {
  await loginViaUI(page, "Berlin drv-1");
  await expect(page.getByText("You're offline. Go online to receive delivery offers.")).toBeVisible();
  await expect(page.getByRole("button", { name: /go online/i })).toBeVisible();
  await expect(page.getByText(/nearby · 5km radius/i)).toHaveCount(0);
});

test("going online queries nearby (200) and shows the nearby section + waiting state", async ({ page }) => {
  await loginViaUI(page, "Berlin drv-1");

  const onlineReq = page.waitForResponse(
    (r) => /\/api\/read\/drivers\/drv-1\/online$/.test(r.url()) && r.request().method() === "POST",
    { timeout: 30_000 },
  );
  const nearbyReq = page.waitForResponse(
    (r) => /\/api\/read\/drivers\/nearby\?/.test(r.url()) && r.request().method() === "GET" && r.status() === 200,
    { timeout: 30_000 },
  );

  await page.getByRole("button", { name: /go online/i }).click();

  expect((await onlineReq).status()).toBe(202);
  expect((await nearbyReq).status()).toBe(200);

  await expect(page.getByText(/online/i).first()).toBeVisible();
  await expect(page.getByText(/waiting for an offer/i)).toBeVisible();
  await expect(page.getByText(/nearby · 5km radius/i)).toBeVisible();
});
```

(The full offer → accept → pickup → deliver path requires a live dispatch workflow with a seeded online driver; that end-to-end flow is exercised via the saga/read-api live stack, not the web e2e. The web e2e covers identity-driven online/offline + layout, consistent with how the other web apps gate their e2e.)

- [ ] **Step 2: Run the e2e (requires the stack up + web-driver dev server, like the other web e2e)**

Run: `pnpm --filter web-driver test:e2e`
Expected: 2 tests pass. (If the local stack/dev server isn't running, this is the same infra-gated condition as the other web e2e suites — note it and proceed; CI runs them.)

- [ ] **Step 3: Update ARCHITECTURE.md**

In `docs/ARCHITECTURE.md`, in the driver-dispatch section (§3 bullet for Phase 3d-i) or a new 3d-ii note, add:
```
- **Driver job UI (Phase 3d-ii):** the driver app (`web-driver`) reads `driverId` from the JWT `sub`
  (drivers are seeded with stable ids `drv-1..drv-4`, so `sub === driverId`). It goes online/offline
  (read-api `POST /drivers/:id/{online,offline}`), and subscribes to `GET /driver/dispatch/stream` — an
  SSE stream fed by a read-api `dispatch-events` consumer (`DispatchStreamService`) and **filtered
  server-side** to the authenticated driver. Offer accept/reject and pickup/deliver POST to the write-api
  dispatch command endpoints, which signal the dispatch child workflow. Reassignment is automatic: a
  reject or offer-timeout makes the workflow re-offer the next-nearest driver (no manual reassign).
```

- [ ] **Step 4: Full verification sweep**

Run the unit/typecheck sweep (no live infra needed):
```bash
pnpm --filter @flashbite/web-shared test
npx tsc --noEmit -p apps/read-api/tsconfig.json
pnpm jest apps/read-api/test/dispatch-stream.spec.ts apps/read-api/test/sse-feeder.spec.ts packages/contracts
pnpm --filter web-driver build
```
Expected: web-shared Vitest all pass; read-api tsc EXIT 0; jest suites pass; web-driver build succeeds.

- [ ] **Step 5: Commit**

```bash
git add apps/web-driver/e2e/driver.spec.ts docs/ARCHITECTURE.md
git commit -m "test+docs(3d-ii): driver e2e for online/layout + dispatch SSE architecture"
```

---

## Self-Review (completed by plan author)

**Spec coverage:**
- Dispatch SSE (DispatchStreamService + feeder + `/driver/dispatch/stream` + server-side filter) → Tasks 4, 5. ✓
- Identity-seeded `drv-1..drv-4`, `sub === driverId`, selector removed → Tasks 6, 8. ✓
- web-shared API fns + `useDispatchStream` + `dispatchStatusLabel` + offer-timeout constant → Tasks 1, 2, 3. ✓
- web-driver OnlineToggle / OfferCard (countdown) / ActiveJobCard / job-first layout → Tasks 7, 8. ✓
- Error handling (accept race via stream reconcile; reject/expiry local dismiss) → Task 8 (`dismissed` state). ✓
- Tests: Vitest (API + hook reducer + labels), read-api filter/mapper tests, Playwright → Tasks 1–5, 9. ✓
- Docs → Task 9. ✓

**Type consistency:** `DispatchView` fields (`status`, `orderId`, `driverId?`, `offeredDriverId?`, `reason?`, `version`, `updatedAt`) used consistently; `toDispatchView`/`reduceDispatch`/`isForDriver`/`dispatchStatusLabel` signatures match across tasks; client fn names (`goOnline`/`acceptDispatch`/…) match their exports and the e2e URL assertions.

**Known constraint surfaced:** `User.id` is a global PK, so `drv-N` ids can't repeat across tenants — Task 6 resolves this by keeping clean ids in `berlin` and tenant-suffixing elsewhere; the UI uses `sub` so it's tenant-agnostic. The full offer→deliver happy path is infra-gated (live workflow) and covered by the saga/read-api live stack rather than the web e2e — noted in Task 9.
