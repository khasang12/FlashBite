# Phase 2 — S4 (Frontend Auth) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the four Next.js frontends from the (now-rejected) trusted `X-Tenant-ID` header to `Authorization: Bearer <JWT>`, with a minimal dev login — completing the Phase 2 hard cut end-to-end.

**Architecture:** A `web-shared` auth store (Zustand + localStorage) holds the access token from the identity service; an `AuthGate` + `LoginForm` (with demo-user quick-pick) gate each app. The API client + SSE hook read the token from the store and send `Authorization: Bearer` (the `tenantId` param is removed — the JWT carries the tenant). Each app gets an `/api/identity/*` rewrite so login is same-origin. web-admin logs in as the operator and uses the cross-tenant `/admin/*` endpoints (replacing the per-tenant fan-out). The gps script + Playwright e2e fetch tokens.

**Tech Stack:** Next.js 16, React 19, Zustand (+persist), `@microsoft/fetch-event-source`, Vitest (web-shared units), Playwright (per-app e2e), identity service (RS256 JWT) at :3003.

**Scope:** S4 ONLY — frontends + gps script + e2e. No backend changes (S1/S2/S3 are merged: write-api/read-api verify Bearer, RLS on the write plane, operator `/admin/*` exist). Decisions locked: **clean API-client signature** (drop `tenantId`, read token from the auth store); **login form with demo-user quick-pick**; token in `localStorage` via Zustand `persist`; identity reached via a per-app `/api/identity/*` rewrite; no refresh/expiry machinery (a 401 → back to login; refresh is backlog).

**Branch:** `phase-2-s4-frontend-auth` off `main` (created; spec at `docs/superpowers/specs/2026-06-15-flashbite-phase-2bcd-jwt-rls-operator-design.md`).

**Seeded users (password `devpassword`):** `customer@berlin.test`, `customer@tokyo.test`, `merchant@berlin.test`, `merchant@tokyo.test`, `driver@berlin.test`, `driver@tokyo.test`, `operator@flashbite.test` (role `operator`).

**Key facts (verified):**
- API client `packages/web-shared/src/api/client.ts`: every fn takes `tenantId` first and spreads `tenantHeader(tenantId) = { "X-Tenant-ID": tenantId }`. Same-origin paths `/api/write/*`, `/api/read/*`.
- SSE `packages/web-shared/src/orders/use-order-stream.ts`: uses `@microsoft/fetch-event-source` (can set headers), sends `{ "X-Tenant-ID": tenantId }` to `/api/read/merchant/orders/stream`.
- Next rewrites (all 4 apps, identical `next.config.ts`): `/api/write/:path*`→:3001, `/api/read/:path*`→:3002. **Rewrites forward `Authorization` automatically** — no proxy plumbing needed EXCEPT route handlers.
- The only route handler today: `apps/web-merchant/app/api/read/merchant/orders/stream/route.ts` (re-injects `X-Tenant-ID`; must forward `Authorization` instead). SSE must stay a route handler (rewrites buffer/break streaming). web-admin will need a NEW route handler for `/admin/orders/stream`.
- `useTenantStore` (cookie `fb-tenant`, default berlin, `skipHydration`) drives tenant today; the switcher is in web-customer `Header` and web-driver page. After S4 tenant comes from the token; the switcher is replaced by login.
- web-admin `hooks/use-admin-data.ts` fans out `listOrders(tenant)` + `getNearbyDrivers(tenant,…)` over `TENANTS` and mounts a per-tenant `<TenantStream>`; replace with operator `getAdminOrders()`/`getAdminDrivers()` + one merged stream.
- web-shared tests = Vitest (`pnpm --filter @flashbite/web-shared test`); `client.test.ts` asserts `X-Tenant-ID` (will change to Bearer).
- contracts exports `TenantNearbyDriver`? NO — S3 put `TenantNearbyDriver` in `apps/read-api/src/admin/admin.service.ts`. web-shared should define its own `TenantNearbyDriver` type (or reuse `NearbyDriver` + `tenantId`). Use a local type in web-shared.

---

## File Structure

**web-shared (foundation):**
- Create `packages/web-shared/src/store/auth-store.ts` — Zustand auth store + `login`/`logout` + JWT-claim decode.
- Create `packages/web-shared/src/store/auth-store.test.ts`.
- Create `packages/web-shared/src/components/login-form.tsx` + `packages/web-shared/src/components/auth-gate.tsx`.
- Modify `packages/web-shared/src/api/client.ts` — drop `tenantId`, Bearer from store, add admin fns.
- Modify `packages/web-shared/src/api/client.test.ts` — assert Bearer.
- Modify `packages/web-shared/src/orders/use-order-stream.ts` — drop `tenantId`, Bearer, optional path.
- Modify `packages/web-shared/src/index.ts` — export auth store, AuthGate, LoginForm, admin fns, types.

**apps (each): `next.config.ts` (+ identity rewrite), wrap in `AuthGate`, drop `tenantId` from calls.**
- web-customer: `next.config.ts`, `app/page.tsx`, `app/checkout/page.tsx`, `app/orders/[orderId]/page.tsx`, `components/header.tsx`.
- web-merchant: `next.config.ts`, `app/page.tsx`, `app/api/read/merchant/orders/stream/route.ts` (forward Authorization).
- web-driver: `next.config.ts`, `app/page.tsx`, `hooks/use-nearby-watch.ts`.
- web-admin: `next.config.ts`, `app/page.tsx`, `hooks/use-admin-data.ts`, `components/tenant-stream.tsx`, NEW `app/api/read/admin/orders/stream/route.ts`.

**Dev tooling:**
- Modify `scripts/stream-gps.sh` — token fetch + Bearer.
- Modify each app's `e2e/*.spec.ts` — token fixture / login; drop `X-Tenant-ID`.

---

## Task 1: Auth store (token + login + claim decode)

**Files:** `packages/web-shared/src/store/auth-store.ts`, `packages/web-shared/src/store/auth-store.test.ts`

**Context:** Holds the access token in localStorage (Zustand `persist`, `skipHydration` like the tenant store). `login()` POSTs to the same-origin `/api/identity/auth/login` (rewrite added per app in later tasks) and stores the token; claims (`sub`/`tenantId`/`role`) are decoded from the JWT payload for display/role-gating (no verification needed client-side — the backend verifies).

- [ ] **Step 1: Write the failing test** — `packages/web-shared/src/store/auth-store.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "./auth-store";

// A minimal RS256-shaped JWT (header.payload.signature) with our claims in the payload.
function makeJwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${b64({ alg: "RS256", typ: "JWT" })}.${b64(claims)}.sig`;
}

describe("auth store", () => {
  beforeEach(() => {
    useAuthStore.setState({ token: null, claims: null });
    vi.restoreAllMocks();
  });

  it("login stores the token and decoded claims", async () => {
    const token = makeJwt({ sub: "u-1", tenantId: "berlin", role: "customer" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ accessToken: token, tokenType: "Bearer", expiresIn: 3600 }), { status: 201 })));
    await useAuthStore.getState().login("customer@berlin.test", "devpassword");
    expect(useAuthStore.getState().token).toBe(token);
    expect(useAuthStore.getState().claims).toEqual({ sub: "u-1", tenantId: "berlin", role: "customer" });
  });

  it("login throws on a 401 and leaves the store empty", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "Invalid email or password" }), { status: 401 })));
    await expect(useAuthStore.getState().login("x@y.test", "bad")).rejects.toThrow();
    expect(useAuthStore.getState().token).toBeNull();
  });

  it("logout clears token and claims", () => {
    useAuthStore.setState({ token: "t", claims: { sub: "s", tenantId: "berlin", role: "customer" } });
    useAuthStore.getState().logout();
    expect(useAuthStore.getState().token).toBeNull();
    expect(useAuthStore.getState().claims).toBeNull();
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `pnpm --filter @flashbite/web-shared exec vitest run src/store/auth-store.test.ts`

- [ ] **Step 3: Implement** — `packages/web-shared/src/store/auth-store.ts`:

```ts
"use client";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export interface AuthClaims {
  sub: string;
  tenantId: string;
  role: string;
}

interface AuthState {
  token: string | null;
  claims: AuthClaims | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

/** Decode the JWT payload (base64url) for display/role-gating. NOT verification — the API verifies. */
function decodeClaims(token: string): AuthClaims {
  const payload = token.split(".")[1] ?? "";
  const json = JSON.parse(
    Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
  ) as Record<string, unknown>;
  return { sub: String(json.sub ?? ""), tenantId: String(json.tenantId ?? ""), role: String(json.role ?? "") };
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      claims: null,
      login: async (email, password) => {
        const res = await fetch("/api/identity/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        });
        if (!res.ok) throw new Error("Invalid email or password");
        const { accessToken } = (await res.json()) as { accessToken: string };
        set({ token: accessToken, claims: decodeClaims(accessToken) });
      },
      logout: () => set({ token: null, claims: null }),
    }),
    { name: "fb-auth", storage: createJSONStorage(() => localStorage), skipHydration: true },
  ),
);
```

Note: `Buffer` is available in Vitest (Node). In the browser it's polyfilled by Next.js for client bundles; if a runtime issue arises, swap to `atob`/`TextDecoder` — but `Buffer` keeps the test simple and Next provides it. (If the reviewer prefers no `Buffer` in browser code, use `atob(payload.replace(...))` + `decodeURIComponent(escape(...))`; keep the test green either way.)

- [ ] **Step 4: Run, expect PASS** — `pnpm --filter @flashbite/web-shared exec vitest run src/store/auth-store.test.ts` (3 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/web-shared/src/store/auth-store.ts packages/web-shared/src/store/auth-store.test.ts
git commit -m "feat(web-shared): auth store (login -> token in localStorage, JWT claim decode)"
```

---

## Task 2: API client — drop tenantId, Bearer from store, admin fns

**Files:** `packages/web-shared/src/api/client.ts`, `packages/web-shared/src/api/client.test.ts`

- [ ] **Step 1: Rewrite the client.** Replace `tenantHeader` with an auth header from the store; remove `tenantId` from all signatures; add admin fns. Full new `packages/web-shared/src/api/client.ts`:

```ts
import type { OrderItem, OrderView } from "@flashbite/contracts";
import { useAuthStore } from "../store/auth-store";

export interface PlaceOrderRequest {
  orderId: string;
  customerId: string;
  items: OrderItem[];
  totalAmount: number;
}

export interface NearbyDriver {
  driverId: string;
  distanceKm: number;
  lng: number;
  lat: number;
}

export interface TenantNearbyDriver extends NearbyDriver {
  tenantId: string;
}

export interface ReportLocationBody {
  lng: number;
  lat: number;
  orderId?: string;
}

/** Authorization header from the current token (verified-JWT identity). */
function authHeader(): Record<string, string> {
  const token = useAuthStore.getState().token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function placeOrder(req: PlaceOrderRequest): Promise<{ orderId: string }> {
  const res = await fetch("/api/write/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: JSON.stringify(req),
  });
  if (!res.ok) throw new Error(`placeOrder failed: ${res.status}`);
  return (await res.json()) as { orderId: string };
}

export async function getOrder(orderId: string): Promise<OrderView | null> {
  const res = await fetch(`/api/read/orders/${encodeURIComponent(orderId)}`, { headers: authHeader() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`getOrder failed: ${res.status}`);
  return (await res.json()) as OrderView;
}

export async function listOrders(): Promise<OrderView[]> {
  const res = await fetch("/api/read/merchant/orders", { headers: authHeader() });
  if (!res.ok) throw new Error(`listOrders failed: ${res.status}`);
  return (await res.json()) as OrderView[];
}

async function signalOrder(orderId: string, action: "accept" | "decline"): Promise<void> {
  const res = await fetch(`/api/write/orders/${encodeURIComponent(orderId)}/${action}`, {
    method: "POST",
    headers: authHeader(),
  });
  if (!res.ok) throw new Error(`${action}Order failed: ${res.status}`);
}

export function acceptOrder(orderId: string): Promise<void> {
  return signalOrder(orderId, "accept");
}
export function declineOrder(orderId: string): Promise<void> {
  return signalOrder(orderId, "decline");
}

export async function reportLocation(driverId: string, body: ReportLocationBody): Promise<{ driverId: string }> {
  const res = await fetch(`/api/read/drivers/${encodeURIComponent(driverId)}/location`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`reportLocation failed: ${res.status}`);
  return (await res.json()) as { driverId: string };
}

export async function getNearbyDrivers(lng: number, lat: number, radiusKm = 5): Promise<NearbyDriver[]> {
  const qs = new URLSearchParams({ lng: String(lng), lat: String(lat), radiusKm: String(radiusKm) });
  const res = await fetch(`/api/read/drivers/nearby?${qs.toString()}`, { headers: authHeader() });
  if (!res.ok) throw new Error(`getNearbyDrivers failed: ${res.status}`);
  return (await res.json()) as NearbyDriver[];
}

// --- Operator console (cross-tenant; requires an operator token) ---

export async function getAdminOrders(): Promise<OrderView[]> {
  const res = await fetch("/api/read/admin/orders", { headers: authHeader() });
  if (!res.ok) throw new Error(`getAdminOrders failed: ${res.status}`);
  return (await res.json()) as OrderView[];
}

export async function getAdminDrivers(): Promise<TenantNearbyDriver[]> {
  const res = await fetch("/api/read/admin/drivers", { headers: authHeader() });
  if (!res.ok) throw new Error(`getAdminDrivers failed: ${res.status}`);
  return (await res.json()) as TenantNearbyDriver[];
}
```

(Confirm the original `getNearbyDrivers` query-string construction; mirror its exact param names — `lng`/`lat`/`radiusKm`.)

- [ ] **Step 2: Rewrite the test** — `packages/web-shared/src/api/client.test.ts`. Set a token in the auth store and assert `Authorization` is sent (no more `X-Tenant-ID`). Pattern for each existing case:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "../store/auth-store";
import { placeOrder, getOrder, listOrders, acceptOrder, declineOrder, reportLocation, getNearbyDrivers } from "./client";

const fetchMock = vi.fn();

beforeEach(() => {
  useAuthStore.setState({ token: "test-token", claims: { sub: "u", tenantId: "berlin", role: "customer" } });
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

function lastInit(): RequestInit {
  return fetchMock.mock.calls[fetchMock.mock.calls.length - 1][1] as RequestInit;
}

it("placeOrder sends Authorization: Bearer", async () => {
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ orderId: "o-1" }), { status: 201 }));
  await placeOrder({ orderId: "o-1", customerId: "c-1", items: [], totalAmount: 0 });
  const init = lastInit();
  expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
  expect((init.headers as Record<string, string>)["X-Tenant-ID"]).toBeUndefined();
});
// ... convert each existing case the same way: set token, call without tenantId, assert Bearer.
```

Keep one test per existing function (placeOrder, getOrder + 404-null, listOrders, acceptOrder, declineOrder, reportLocation + with-orderId, getNearbyDrivers + default radius), each asserting `Authorization: "Bearer test-token"` and no `X-Tenant-ID`. Add one for `getAdminOrders` / `getAdminDrivers` hitting `/api/read/admin/*`.

- [ ] **Step 3: Run, expect PASS** — `pnpm --filter @flashbite/web-shared exec vitest run src/api/client.test.ts`

- [ ] **Step 4: Commit**

```bash
git add packages/web-shared/src/api/client.ts packages/web-shared/src/api/client.test.ts
git commit -m "refactor(web-shared): API client uses Bearer from auth store; drop tenantId arg; add admin fns"
```

---

## Task 3: SSE hook — drop tenantId, Bearer, optional path

**Files:** `packages/web-shared/src/orders/use-order-stream.ts`

**Context:** `useOrderStream` must send `Authorization: Bearer` and stop sending `X-Tenant-ID`. Add an optional `path` so the admin can point it at the merged operator stream. The merchant stream stays the default.

- [ ] **Step 1: Rewrite** `packages/web-shared/src/orders/use-order-stream.ts` — read the current file first to preserve the exact `onEvent`/`parseStreamData` contract; then change the signature to drop `tenantId` and read the token, e.g.:

```ts
"use client";
import { useEffect, useRef } from "react";
import { fetchEventSource } from "@microsoft/fetch-event-source";
import { useAuthStore } from "../store/auth-store";
// ... keep existing OrderStreamEvent/parseStreamData imports/exports

export function useOrderStream(
  onEvent: (event: OrderStreamEvent) => void,
  onOpen?: () => void,
  path = "/api/read/merchant/orders/stream",
): void {
  const onEventRef = useRef(onEvent);
  const onOpenRef = useRef(onOpen);
  onEventRef.current = onEvent;
  onOpenRef.current = onOpen;

  const token = useAuthStore((s) => s.token);

  useEffect(() => {
    if (!token) return;
    const ctrl = new AbortController();
    void fetchEventSource(path, {
      headers: { Authorization: `Bearer ${token}` },
      signal: ctrl.signal,
      openWhenHidden: true,
      onopen: async () => {
        onOpenRef.current?.();
      },
      onmessage: (msg) => {
        const event = parseStreamData(msg.data);
        if (event) onEventRef.current(event);
      },
    }).catch(() => {});
    return () => ctrl.abort();
  }, [token, path]);
}
```

(Match the real `parseStreamData`/`OrderStreamEvent` usage and the existing `onmessage` body exactly. The admin merged stream tags each event with `tenantId`; if `OrderStreamEvent` doesn't carry `tenantId`, extend the admin consumption in Task 8 — keep this hook generic.)

- [ ] **Step 2: Verify web-shared unit suite still green** — `pnpm --filter @flashbite/web-shared test` (existing order-stream tests, if any, plus the new auth/client tests). Fix any `useOrderStream` call mismatch only within web-shared.

- [ ] **Step 3: Commit**

```bash
git add packages/web-shared/src/orders/use-order-stream.ts
git commit -m "refactor(web-shared): useOrderStream sends Bearer; drop tenantId; optional path for admin stream"
```

---

## Task 4: LoginForm + AuthGate + exports

**Files:** `packages/web-shared/src/components/login-form.tsx`, `packages/web-shared/src/components/auth-gate.tsx`, `packages/web-shared/src/index.ts`

**Context:** `AuthGate` rehydrates the auth store, shows `LoginForm` when there's no token (or a wrong-role notice), else renders children with a small "logged in as … / Log out" bar. `LoginForm` has email+password + a demo-user quick-pick (one click fills credentials). Reuses existing web-shared UI primitives (`Button`, `Input`, `Card`).

- [ ] **Step 1: LoginForm** — `packages/web-shared/src/components/login-form.tsx`:

```tsx
"use client";
import { useState } from "react";
import { Button } from "./button";
import { Input } from "./input";

export interface DemoUser {
  label: string;
  email: string;
}

const DEMO_PASSWORD = "devpassword";

export function LoginForm({
  demoUsers,
  onSubmit,
  title = "Sign in",
}: {
  demoUsers: DemoUser[];
  onSubmit: (email: string, password: string) => Promise<void>;
  title?: string;
}): React.ReactElement {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit(email, password);
    } catch {
      setError("Invalid email or password");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto mt-24 w-full max-w-sm space-y-4 p-6">
      <h1 className="text-xl font-semibold">{title}</h1>
      <form onSubmit={submit} className="space-y-3">
        <Input type="email" placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="email" />
        <Input type="password" placeholder="password" value={password} onChange={(e) => setPassword(e.target.value)} aria-label="password" />
        {error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null}
        <Button type="submit" disabled={busy} className="w-full">{busy ? "Signing in…" : "Sign in"}</Button>
      </form>
      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">Demo users (password: {DEMO_PASSWORD})</p>
        <div className="flex flex-wrap gap-2">
          {demoUsers.map((u) => (
            <Button key={u.email} type="button" variant="outline" size="sm"
              onClick={() => { setEmail(u.email); setPassword(DEMO_PASSWORD); }}>
              {u.label}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}
```

(Confirm the real `Button`/`Input` prop APIs — `variant`/`size` exist on the shared `Button` per the design system; if not, drop those props. Import paths must match the actual component filenames in `packages/web-shared/src/components/`.)

- [ ] **Step 2: AuthGate** — `packages/web-shared/src/components/auth-gate.tsx`:

```tsx
"use client";
import { useEffect, useState } from "react";
import { useAuthStore } from "../store/auth-store";
import { LoginForm, type DemoUser } from "./login-form";
import { Button } from "./button";

export function AuthGate({
  children,
  demoUsers,
  requiredRole,
  title,
}: {
  children: React.ReactNode;
  demoUsers: DemoUser[];
  requiredRole?: string;
  title?: string;
}): React.ReactNode {
  const token = useAuthStore((s) => s.token);
  const claims = useAuthStore((s) => s.claims);
  const login = useAuthStore((s) => s.login);
  const logout = useAuthStore((s) => s.logout);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    void useAuthStore.persist.rehydrate();
    setHydrated(true);
  }, []);

  if (!hydrated) return null;
  if (!token) return <LoginForm demoUsers={demoUsers} onSubmit={login} title={title} />;
  if (requiredRole && claims?.role !== requiredRole) {
    return (
      <div className="mx-auto mt-24 max-w-sm space-y-3 p-6 text-center">
        <p className="text-sm">This view requires the <b>{requiredRole}</b> role. You are <b>{claims?.role}</b>.</p>
        <Button onClick={logout}>Log out</Button>
      </div>
    );
  }
  return (
    <>
      <div className="flex items-center justify-end gap-3 border-b px-4 py-2 text-xs text-muted-foreground">
        <span>{claims?.role}@{claims?.tenantId}</span>
        <Button variant="outline" size="sm" onClick={logout}>Log out</Button>
      </div>
      {children}
    </>
  );
}
```

- [ ] **Step 3: Export** — add to `packages/web-shared/src/index.ts`:

```ts
export * from "./store/auth-store";
export * from "./components/login-form";
export * from "./components/auth-gate";
```

(And ensure the new client admin fns + `TenantNearbyDriver` are exported — they are if `index.ts` does `export * from "./api/client"`; verify.)

- [ ] **Step 4: Build-check web-shared** — `pnpm --filter @flashbite/web-shared test` (units green). A full typecheck happens when apps build in later tasks.

- [ ] **Step 5: Commit**

```bash
git add packages/web-shared/src/components/login-form.tsx packages/web-shared/src/components/auth-gate.tsx packages/web-shared/src/index.ts
git commit -m "feat(web-shared): LoginForm (demo quick-pick) + AuthGate (role-gated) + exports"
```

---

## Task 5: web-customer — identity rewrite, AuthGate, Bearer calls

**Files:** `apps/web-customer/next.config.ts`, `apps/web-customer/app/page.tsx`, `apps/web-customer/app/checkout/page.tsx`, `apps/web-customer/app/orders/[orderId]/page.tsx`, `apps/web-customer/components/header.tsx`

- [ ] **Step 1: identity rewrite** — in `apps/web-customer/next.config.ts`, add an identity origin + rewrite (keep the existing two):

```ts
const IDENTITY_API = process.env.IDENTITY_API_ORIGIN ?? "http://localhost:3003";
// ...in rewrites() return array, add:
{ source: "/api/identity/:path*", destination: `${IDENTITY_API}/:path*` },
```

- [ ] **Step 2: Gate the app + drop tenantId.** Wrap the storefront in `AuthGate` (customer demo users), and update every API call to the new signatures (remove the `tenant` arg). `app/page.tsx`: wrap returned UI in `<AuthGate demoUsers={[{label:"Berlin customer",email:"customer@berlin.test"},{label:"Tokyo customer",email:"customer@tokyo.test"}]} requiredRole="customer" title="FlashBite — Customer">…</AuthGate>`. The menu still keys off a tenant for display — read it from `useAuthStore((s)=>s.claims?.tenantId)` instead of `useTenantStore`. `app/checkout/page.tsx`: `placeOrder(req)` (no tenant). `app/orders/[orderId]/page.tsx`: `getOrder(orderId)` (no tenant). `components/header.tsx`: remove the tenant `DropdownMenu` switcher (tenant now comes from the token); keep the cart link. Remove now-unused `useTenantStore`/`TENANTS` imports.

(Read each file first; make the minimal change to drop the `tenant` argument and source the tenant from `claims.tenantId` where the UI needs to display it, e.g. `getMenu(tenantId)`.)

- [ ] **Step 3: Build** — `pnpm --filter web-customer build`
Expected: compiles. Fix any leftover `tenant`-arg call or unused import.

- [ ] **Step 4: Commit**

```bash
git add apps/web-customer
git commit -m "feat(web-customer): login gate + Bearer API calls; identity rewrite; drop tenant switcher"
```

---

## Task 6: web-merchant — AuthGate, Bearer, SSE route handler

**Files:** `apps/web-merchant/next.config.ts`, `apps/web-merchant/app/page.tsx`, `apps/web-merchant/app/api/read/merchant/orders/stream/route.ts`

- [ ] **Step 1: identity rewrite** — add the `/api/identity/:path*` rewrite to `apps/web-merchant/next.config.ts` (as in Task 5 Step 1).

- [ ] **Step 2: SSE route handler forwards Authorization** — replace `apps/web-merchant/app/api/read/merchant/orders/stream/route.ts` body so it forwards the caller's `Authorization` instead of `X-Tenant-ID`:

```ts
const READ_API = process.env.READ_API_ORIGIN ?? "http://localhost:3002";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const auth = request.headers.get("authorization");
  const upstream = await fetch(`${READ_API}/merchant/orders/stream`, {
    headers: {
      ...(auth ? { Authorization: auth } : {}),
      Accept: "text/event-stream",
    },
    signal: request.signal,
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
  });
}
```

- [ ] **Step 3: Gate + Bearer** — `app/page.tsx`: wrap in `<AuthGate demoUsers={[{label:"Berlin merchant",email:"merchant@berlin.test"},{label:"Tokyo merchant",email:"merchant@tokyo.test"}]} requiredRole="merchant" title="FlashBite — Merchant">`. Update calls: `listOrders()`, `useOrderStream(onEvent, resync)` (no tenant), `getOrder(id)`, `acceptOrder(id)`, `declineOrder(id)`. Remove `useTenantStore` usage (tenant label can come from `claims.tenantId`).

- [ ] **Step 4: Build** — `pnpm --filter web-merchant build` (compiles; fix leftovers).

- [ ] **Step 5: Commit**

```bash
git add apps/web-merchant
git commit -m "feat(web-merchant): login gate + Bearer; SSE route handler forwards Authorization"
```

---

## Task 7: web-driver — AuthGate, Bearer, drop switcher

**Files:** `apps/web-driver/next.config.ts`, `apps/web-driver/app/page.tsx`, `apps/web-driver/hooks/use-nearby-watch.ts`

- [ ] **Step 1: identity rewrite** — add `/api/identity/:path*` to `apps/web-driver/next.config.ts`.

- [ ] **Step 2: Gate + Bearer + drop switcher** — `app/page.tsx`: wrap in `<AuthGate demoUsers={[{label:"Berlin driver",email:"driver@berlin.test"},{label:"Tokyo driver",email:"driver@tokyo.test"}]} requiredRole="driver" title="FlashBite — Driver">`. Remove the tenant `<Select>` switcher + `useTenantStore`/`mounted` gating tied to it; the nearby view centers on the token's tenant (read `claims.tenantId` and look up `CITY_CENTERS[tenantId]`). `hooks/use-nearby-watch.ts`: change `getNearbyDrivers(tenant, lng, lat, r)` → `getNearbyDrivers(lng, lat, r)` and derive the center from `claims.tenantId` (pass the center in, or read claims in the hook).

- [ ] **Step 3: Build** — `pnpm --filter web-driver build`.

- [ ] **Step 4: Commit**

```bash
git add apps/web-driver
git commit -m "feat(web-driver): login gate + Bearer nearby calls; drop tenant switcher"
```

---

## Task 8: web-admin — operator login + /admin/* (replace fan-out)

**Files:** `apps/web-admin/next.config.ts`, `apps/web-admin/app/page.tsx`, `apps/web-admin/hooks/use-admin-data.ts`, `apps/web-admin/components/tenant-stream.tsx`, Create `apps/web-admin/app/api/read/admin/orders/stream/route.ts`

**Context:** Admin logs in as the **operator** and uses the cross-tenant endpoints, replacing the per-tenant fan-out. Orders + drivers come from single calls; the SSE switches from two per-tenant streams to one merged operator stream (`/admin/orders/stream`, events tagged `tenantId`). SSE needs a route handler (rewrites buffer streaming).

- [ ] **Step 1: identity rewrite** — add `/api/identity/:path*` to `apps/web-admin/next.config.ts`.

- [ ] **Step 2: admin SSE route handler** — create `apps/web-admin/app/api/read/admin/orders/stream/route.ts` (mirror the merchant one, but path `/admin/orders/stream`):

```ts
const READ_API = process.env.READ_API_ORIGIN ?? "http://localhost:3002";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const auth = request.headers.get("authorization");
  const upstream = await fetch(`${READ_API}/admin/orders/stream`, {
    headers: { ...(auth ? { Authorization: auth } : {}), Accept: "text/event-stream" },
    signal: request.signal,
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
  });
}
```

- [ ] **Step 3: Replace the fan-out** — `hooks/use-admin-data.ts`: replace `for (tenant of TENANTS) listOrders(tenant)` with a single `getAdminOrders()` → set all orders; replace the per-tenant `getNearbyDrivers` loop with a single `getAdminDrivers()` → group the returned `TenantNearbyDriver[]` into `driversByTenant` (group by `.tenantId`). Keep the analytics helpers (they consume `OrderView[]`). Keep the mountedRef unmount-safety.

- [ ] **Step 4: Merged SSE** — `components/tenant-stream.tsx` (and its usage in `app/page.tsx`): replace the per-tenant `<TenantStream tenant={t}>` instances with ONE stream via `useOrderStream(onEvent, onResync, "/api/read/admin/orders/stream")`. The admin merged events carry `tenantId` in `data` — adapt `onEvent` to route by `event.tenantId` (the operator stream tags each event). If `OrderStreamEvent` lacks `tenantId`, read it off the parsed payload in the admin handler. On (re)connect, call `getAdminOrders()` to resync.

- [ ] **Step 5: Gate** — `app/page.tsx`: wrap in `<AuthGate demoUsers={[{label:"Operator",email:"operator@flashbite.test"}]} requiredRole="operator" title="FlashBite — Operator">`.

- [ ] **Step 6: Build** — `pnpm --filter web-admin build`. Fix leftover per-tenant calls/imports.

- [ ] **Step 7: Commit**

```bash
git add apps/web-admin
git commit -m "feat(web-admin): operator login + cross-tenant /admin/* (orders, drivers, merged SSE)"
```

---

## Task 9: gps script — fetch a token, use Bearer

**Files:** `scripts/stream-gps.sh`

- [ ] **Step 1: Token fetch + Bearer.** At the top (after the env defaults), add an identity login that captures the token, and swap both `-H "X-Tenant-ID: ${TENANT}"` for `-H "Authorization: Bearer ${TOKEN}"`:

```bash
IDENTITY_URL="${IDENTITY_URL:-http://localhost:3003}"
DRIVER_EMAIL="${DRIVER_EMAIL:-driver@${TENANT}.test}"
SEED_PASSWORD="${SEED_PASSWORD:-devpassword}"

TOKEN="$(curl -s -X POST "${IDENTITY_URL}/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"${DRIVER_EMAIL}\",\"password\":\"${SEED_PASSWORD}\"}" \
  | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')"
if [ -z "$TOKEN" ]; then
  echo "login failed for ${DRIVER_EMAIL} at ${IDENTITY_URL} — is dev:identity running + users seeded?" >&2
  exit 1
fi
```

Then replace the two `-H "X-Tenant-ID: ${TENANT}"` lines (the POST and the nearby GET) with `-H "Authorization: Bearer ${TOKEN}"`. The tenant now comes from the token (driver@${TENANT}.test). Update the script's header comment to document `DRIVER_EMAIL`/`SEED_PASSWORD`/`IDENTITY_URL` and that it logs in first. (Uses `sed` to avoid a `jq` dependency.)

- [ ] **Step 2: Smoke test** (identity + read-api + telemetry running, users seeded):

```bash
pnpm dev:identity   # if not running
DRIVER=drv-1 TENANT=berlin ./scripts/stream-gps.sh   # expect 202s, not 401
```
Run a few seconds, confirm `202` responses (Ctrl+C). If it 401s, the token wasn't captured — check the login response.

- [ ] **Step 3: Commit**

```bash
git add scripts/stream-gps.sh
git commit -m "feat(scripts): stream-gps logs in for a driver JWT and sends Bearer (no X-Tenant-ID)"
```

---

## Task 10: Playwright e2e — token + login; drop X-Tenant-ID

**Files:** `apps/web-customer/e2e/storefront.spec.ts`, `apps/web-merchant/e2e/merchant.spec.ts`, `apps/web-driver/e2e/driver.spec.ts`, `apps/web-admin/e2e/admin.spec.ts` (+ a small shared login helper per app)

**Context:** Two changes per spec: (a) direct API seed/assert calls must use a Bearer token (the backend now 401s on `X-Tenant-ID`); (b) any spec that loads the app UI hits the `AuthGate` login wall first. For (a), fetch a token from identity in `beforeAll`. For (b), drive the login form (the demo quick-pick button + Sign in) — this exercises the real flow.

- [ ] **Step 1: per-app login helper** — add a tiny helper (e.g. `apps/<app>/e2e/auth.ts`) that mints a token via the identity API for direct calls, and a `loginViaUI(page, demoLabel)` that clicks the demo button + Sign in:

```ts
import { APIRequestContext, Page, expect } from "@playwright/test";

export async function apiToken(request: APIRequestContext, email: string, password = "devpassword"): Promise<string> {
  const res = await request.post("http://localhost:3003/auth/login", {
    headers: { "Content-Type": "application/json" },
    data: { email, password },
  });
  expect(res.ok()).toBeTruthy();
  return ((await res.json()) as { accessToken: string }).accessToken;
}

export async function loginViaUI(page: Page, demoLabel: string): Promise<void> {
  await page.getByRole("button", { name: demoLabel }).click(); // demo quick-pick fills creds
  await page.getByRole("button", { name: "Sign in" }).click();
}
```

- [ ] **Step 2: migrate each spec.** Replace direct calls like `api.post("http://localhost:3001/orders", { headers: { "X-Tenant-ID": "berlin" }, … })` with a Bearer header from `apiToken(...)` (customer for placing, merchant for accept/decline). Replace any tenant-isolation check that relied on swapping `X-Tenant-ID` with two tokens (e.g. `apiToken(request, "customer@berlin.test")` vs `…@tokyo.test`). For UI-loading steps, call `loginViaUI(page, "Berlin customer")` (or the relevant demo label) after `page.goto("/")` before asserting on app content.

Apply per app:
- customer (`storefront.spec.ts`): customer token for place/seed; `loginViaUI(page,"Berlin customer")` for UI; isolation test uses berlin vs tokyo customer tokens.
- merchant (`merchant.spec.ts`): merchant token for accept/decline + customer token for placing the order it acts on; `loginViaUI(page,"Berlin merchant")`.
- driver (`driver.spec.ts`): driver token for location seeding; `loginViaUI(page,"Berlin driver")`.
- admin (`admin.spec.ts`): operator token for `/admin/*` direct calls + customer token to seed cross-tenant orders; `loginViaUI(page,"Operator")`.

- [ ] **Step 3: Run e2e per app** (infra + the relevant services + identity up, users seeded). For each:

```bash
pnpm seed:users
pnpm test:e2e:web        # customer
pnpm test:e2e:merchant
pnpm test:e2e:driver
pnpm test:e2e:admin
```
Expected: green. These need the backend services running (write-api/read-api/identity + outbox/projection for order flow). If a spec is environment-heavy and flaky for non-auth reasons, note it; do not weaken auth assertions.

- [ ] **Step 4: Commit**

```bash
git add apps/*/e2e
git commit -m "test(e2e): migrate Playwright specs to Bearer tokens + UI login (drop X-Tenant-ID)"
```

---

## Task 11: Docs + full verification

**Files:** `README.md`, `apps/write-api/requests.http` (optional), `.env.example`

- [ ] **Step 1: README + env** — in `README.md` "Run the full app", note that the frontends now require login (seeded `role@tenant.test` / `devpassword`; admin = `operator@flashbite.test`) and that `pnpm seed:users` + `pnpm dev:identity` are prerequisites for the UIs. If apps need `IDENTITY_API_ORIGIN`/`READ_API_ORIGIN`/`WRITE_API_ORIGIN` overrides documented, add them to `.env.example` (defaults already point at localhost). No `NEXT_PUBLIC_*` needed (login is same-origin via the rewrite).

- [ ] **Step 2: Frontend unit + builds** — verify the whole web layer:

```bash
pnpm --filter @flashbite/web-shared test        # vitest: auth store + client (Bearer) + order helpers
pnpm --filter web-customer build
pnpm --filter web-merchant build
pnpm --filter web-driver build
pnpm --filter web-admin build
```
Expected: all green; no `tenant`-arg or `X-Tenant-ID` references remain in app/web-shared source (grep to confirm: `grep -rn "X-Tenant-ID" apps packages/web-shared/src` → only comments, if any).

- [ ] **Step 3: Backend suite unaffected** — `pnpm test` (should remain green; S4 touched no backend code).

- [ ] **Step 4: Manual smoke (document, optional to run):** bring up infra + write-api + read-api + outbox + projection + identity + a frontend; log in via a demo user; place/track an order (customer), accept (merchant), watch nearby (driver + gps script), operator dashboard (admin). Confirm no 401s.

- [ ] **Step 5: Commit**

```bash
git add README.md .env.example
git commit -m "docs: frontends require login (seeded users); identity + seed prereqs for the UIs"
```

---

## Self-review notes (coverage check)

- **Auth store (token + login + claims)** → Task 1.
- **Bearer in client (drop tenantId) + admin fns** → Task 2.
- **Bearer in SSE (drop tenantId, admin path)** → Task 3.
- **LoginForm (demo quick-pick) + AuthGate (role-gated)** → Task 4.
- **Per-app login + Bearer + identity rewrite** → Tasks 5–8 (customer, merchant, driver, admin).
- **web-admin → operator + /admin/* (replace fan-out + merged SSE)** → Task 8.
- **gps script token** → Task 9.
- **e2e token + UI login** → Task 10.
- **Docs + full verification** → Task 11.
- **Out of scope:** no backend changes; no refresh tokens / expiry handling (backlog); `useTenantStore` may remain for non-auth UI niceties but is no longer the tenancy source (remove its tenancy usage; leave the file if other code imports it — verify).

## Notes for the executor

- The Next rewrites forward `Authorization` automatically — only the SSE route handlers (merchant existing, admin new) need manual header forwarding.
- The frontends call identity same-origin via `/api/identity/*` → :3003 (rewrite) — no CORS, no `NEXT_PUBLIC` identity URL.
- For the UIs to work end-to-end you need `pnpm dev:identity` + `pnpm seed:users` (plus write/read/outbox/projection for the order flow).
- `useAuthStore` mirrors `useTenantStore`'s `skipHydration` pattern — `AuthGate` calls `useAuthStore.persist.rehydrate()` on mount (avoids SSR mismatch).
- Keep commits per task; each app builds independently after its task.
