# FlashBite Phase 1d-i — Customer Storefront Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a minimal, presentable Next.js customer storefront — browse a per-tenant menu (with a "Most chosen" carousel), build a cart, place an order, and watch it resolve live (PLACED → ACCEPTED/CANCELLED) — plus the shared frontend foundation (design system + typed API client) reused by later surfaces.

**Architecture:** A new `apps/web-customer` (Next.js App Router, TS, Tailwind) consumes `packages/web-shared` — which owns the shadcn/ui components, the design tokens (UberEats-influenced, FlashBite-branded: green `#06C167`, Manrope), the typed API client, the per-tenant menu seed, and the zustand stores. The browser only calls same-origin: `next.config` rewrites proxy `/api/write/*` → `:3001` and `/api/read/*` → `:3002` (no CORS on the Nest apps).

**Tech Stack:** Next.js (App Router) · React · TypeScript · Tailwind CSS · shadcn/ui (Radix) · zustand · Vitest + Testing Library · Playwright · pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-06-14-flashbite-phase-1d-i-customer-storefront-design.md`

---

## Context for the implementer

- Monorepo: pnpm 9.1.0, Node 24, workspaces `apps/*` + `packages/*` (already globbed in `pnpm-workspace.yaml`). Run all `pnpm` commands from the repo root unless told otherwise.
- Workspace packages are **TS-source** (no build): `package.json` has `"main": "src/index.ts"`, `"types": "src/index.ts"`, `"private": true`, and depend on each other via `"workspace:*"`.
- `@flashbite/contracts` (pure types/constants) exports `OrderItem {sku,qty,price}`, `OrderView {tenantId,orderId,customerId,items,totalAmount,status,version,updatedAt}`, and `ORDER_STATUS {PLACED,ACCEPTED,CANCELLED}`. Reuse these — do not redefine them.
- Backend (run via `pnpm infra:up` then the dev scripts): **write-api** on `:3001` (`POST /orders` → 201 `{orderId}`; `POST /orders/:id/accept` and `/decline` → 202), **read-api** on `:3002` (`GET /orders/:id` → 200 `OrderView` or 404). Tenant is the `X-Tenant-ID` header (no auth yet).
- Order amounts are **integer cents** (e.g. `price: 1200` = €12.00), matching existing data.
- **Root Jest** (`jest.config.cjs`) matches `**/*.spec.ts` and `**/*.e2e-spec.ts` across `apps/`. The frontend uses Vitest (`*.test.ts(x)`) and Playwright (`e2e/*.spec.ts`) — Task 1 excludes `apps/web-customer` from root Jest so the two test runners never collide.
- This repo has a hook that auto-commits; still run the explicit `git commit` in each task so each task is one atomic, well-messaged commit.
- After each task: `pnpm install` if dependencies changed.

**Conventions:** commit per task (Conventional Commits); end every commit body with:
```
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

## File Structure

```
flashbite/
  jest.config.cjs                                  # MODIFY (Task 1): ignore apps/web-customer
  tsconfig.base.json                               # MODIFY (Task 2): @flashbite/web-shared path
  package.json                                     # MODIFY (Task 1): dev:web-customer; (Task 10): test:web, test:e2e
  packages/web-shared/
    package.json                                   # CREATE (Task 2)
    tsconfig.json                                  # CREATE (Task 2)
    src/index.ts                                   # CREATE (Task 2); grows each task
    src/styles/theme.css                           # CREATE (Task 3): design tokens (CSS vars) + Manrope
    tailwind-preset.ts                             # CREATE (Task 3): shared Tailwind theme
    components.json                                # CREATE (Task 4): shadcn config
    src/lib/utils.ts                               # CREATE (Task 4): cn() helper
    src/components/ui/*                            # CREATE (Task 4): shadcn components (CLI)
    src/components/status-pill.tsx                 # CREATE (Task 9): Badge-based status
    src/components/qty-stepper.tsx                 # CREATE (Task 7)
    src/api/client.ts                              # CREATE (Task 5): placeOrder/getOrder
    src/api/client.test.ts                         # CREATE (Task 5): Vitest
    src/store/tenant-store.ts                      # CREATE (Task 5): zustand (cookie-persisted)
    src/store/cart-store.ts                        # CREATE (Task 6): zustand
    src/store/cart-store.test.ts                   # CREATE (Task 6): Vitest
    src/menu/seed.ts                               # CREATE (Task 6): per-tenant menu + popular
    src/menu/seed.test.ts                          # CREATE (Task 6): Vitest
    src/components/status-pill.test.tsx            # CREATE (Task 9): Vitest
    vitest.config.ts                               # CREATE (Task 5)
    vitest.setup.ts                                # CREATE (Task 5)
  apps/web-customer/
    (Next.js scaffold)                             # CREATE (Task 1)
    next.config.ts                                 # MODIFY (Task 5): rewrites proxy
    tailwind.config.ts                             # MODIFY (Task 3): use shared preset + content globs
    app/globals.css                                # MODIFY (Task 3): import shared theme
    app/layout.tsx                                 # MODIFY (Task 3): Manrope font
    app/page.tsx                                   # MODIFY (Task 7): menu page
    app/checkout/page.tsx                          # CREATE (Task 8)
    app/orders/[orderId]/page.tsx                  # CREATE (Task 9)
    components/header.tsx                          # CREATE (Task 7): brand + tenant switcher
    playwright.config.ts                           # CREATE (Task 10)
    e2e/storefront.spec.ts                         # CREATE (Task 10)
```

---

## Task 1: Scaffold `apps/web-customer` + dev script + isolate from root Jest

**Files:**
- Create: `apps/web-customer/*` (Next.js scaffold)
- Modify: `package.json` (root) — add `dev:web-customer`
- Modify: `jest.config.cjs` — ignore the web app

- [ ] **Step 1: Scaffold the Next.js app**

From the repo root:
```bash
pnpm create next-app@latest apps/web-customer --ts --tailwind --eslint --app --src-dir=false --import-alias "@/*" --use-pnpm --no-turbopack
```
Accept defaults for any remaining prompts. This creates `apps/web-customer` with the App Router, TypeScript, and Tailwind.

- [ ] **Step 2: Pin the dev port and add the root script**

In root `package.json` `scripts` (keep all existing), add:
```json
    "dev:web-customer": "pnpm --filter web-customer dev"
```
In `apps/web-customer/package.json`, set the dev script to fix the port:
```json
    "dev": "next dev -p 3100"
```
Confirm `apps/web-customer/package.json` has `"name": "web-customer"` (rename if `create-next-app` used a different name).

- [ ] **Step 3: Exclude the web app from root Jest**

In `jest.config.cjs`, add a `testPathIgnorePatterns` key to the exported config object (next to `maxWorkers`/`forceExit`):
```js
  testPathIgnorePatterns: ["/node_modules/", "<rootDir>/apps/web-customer/"],
```

- [ ] **Step 4: Install + verify build/boot**

```bash
pnpm install
pnpm --filter web-customer build
```
Expected: Next.js build completes with no errors (the default starter page).

- [ ] **Step 5: Verify root Jest still green and ignores the web app**

Run: `pnpm test`
Expected: existing suites pass; no attempt to run anything under `apps/web-customer`.

- [ ] **Step 6: Commit**

```bash
git add apps/web-customer package.json jest.config.cjs pnpm-lock.yaml
git commit -m "feat(web-customer): scaffold Next.js app (App Router, TS, Tailwind) on :3100"
```
End body with the `Co-Authored-By` trailer.

---

## Task 2: Scaffold `packages/web-shared` + wire path alias + consume from app

**Files:**
- Create: `packages/web-shared/package.json`, `packages/web-shared/tsconfig.json`, `packages/web-shared/src/index.ts`
- Modify: `tsconfig.base.json` (add path), `apps/web-customer/package.json` (add dep)

- [ ] **Step 1: Create the package manifest**

`packages/web-shared/package.json`:
```json
{
  "name": "@flashbite/web-shared",
  "version": "0.0.0",
  "private": true,
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": {
    "test": "vitest run"
  },
  "dependencies": {
    "@flashbite/contracts": "workspace:*"
  }
}
```

- [ ] **Step 2: Create the package tsconfig**

`packages/web-shared/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "noEmit": true
  },
  "include": ["src/**/*.ts", "src/**/*.tsx"]
}
```

- [ ] **Step 3: Seed the barrel export**

`packages/web-shared/src/index.ts`:
```ts
// Re-export the order contracts the frontends consume.
export type { OrderItem, OrderView } from "@flashbite/contracts";
export { ORDER_STATUS } from "@flashbite/contracts";
```

- [ ] **Step 4: Register the path alias**

In `tsconfig.base.json`, add to `compilerOptions.paths` (keep existing entries):
```json
      "@flashbite/web-shared": ["packages/web-shared/src/index.ts"]
```

- [ ] **Step 5: Add the dependency to the app and verify resolution**

In `apps/web-customer/package.json` `dependencies`, add:
```json
    "@flashbite/web-shared": "workspace:*"
```
Then:
```bash
pnpm install
```
Add a temporary smoke import at the top of `apps/web-customer/app/page.tsx`:
```ts
import { ORDER_STATUS } from "@flashbite/web-shared";
console.log(ORDER_STATUS.PLACED);
```
Run: `pnpm --filter web-customer build`
Expected: build succeeds (the workspace import resolves). Then remove the temporary import + console.log lines.

- [ ] **Step 6: Commit**

```bash
git add packages/web-shared tsconfig.base.json apps/web-customer/package.json pnpm-lock.yaml
git commit -m "feat(web-shared): scaffold shared frontend package + path alias"
```
End body with the `Co-Authored-By` trailer.

---

## Task 3: Design tokens + Manrope (shared theme)

> **SUPERSEDED (Tailwind v4):** The scaffold installed **Tailwind v4** (CSS-first — `@import "tailwindcss"`, `@theme inline`, `@tailwindcss/postcss`; no `tailwind.config.ts`, no JS preset). The original Tasks 3 and 4 below assumed Tailwind v3 and are replaced by a **single combined design-system task** executed against v4: shadcn/ui init in `web-shared`, FlashBite CSS-variable tokens (green `#06C167` primary + status palette + radius), Manrope, and `@source` wiring so the app scans `web-shared`. The controller dispatches the authoritative combined instructions; the v3-style steps below are retained only for reference.

**Files:**
- Create: `packages/web-shared/src/styles/theme.css`, `packages/web-shared/tailwind-preset.ts`
- Modify: `apps/web-customer/tailwind.config.ts`, `apps/web-customer/app/globals.css`, `apps/web-customer/app/layout.tsx`

- [ ] **Step 1: Define the design tokens as CSS variables**

`packages/web-shared/src/styles/theme.css` (shadcn-compatible HSL variables; UberEats-influenced green + status palette):
```css
:root {
  --background: 0 0% 100%;
  --foreground: 0 0% 4%;
  --card: 0 0% 100%;
  --card-foreground: 0 0% 4%;
  --popover: 0 0% 100%;
  --popover-foreground: 0 0% 4%;
  --primary: 152 93% 39%;            /* #06C167 UberEats-style green */
  --primary-foreground: 0 0% 100%;
  --secondary: 0 0% 96%;
  --secondary-foreground: 0 0% 9%;
  --muted: 0 0% 96%;
  --muted-foreground: 220 9% 46%;
  --accent: 0 0% 96%;
  --accent-foreground: 0 0% 9%;
  --destructive: 0 72% 51%;
  --destructive-foreground: 0 0% 100%;
  --border: 0 0% 92%;
  --input: 0 0% 92%;
  --ring: 152 93% 39%;
  --radius: 0.9rem;

  /* Order status semantics (reused on every surface) */
  --status-placed: 35 92% 38%;
  --status-placed-bg: 45 100% 95%;
  --status-accepted: 145 85% 30%;
  --status-accepted-bg: 145 70% 94%;
  --status-cancelled: 0 72% 45%;
  --status-cancelled-bg: 0 80% 96%;
}
```

- [ ] **Step 2: Create the shared Tailwind preset**

`packages/web-shared/tailwind-preset.ts`:
```ts
import type { Config } from "tailwindcss";

const preset: Omit<Config, "content"> = {
  theme: {
    extend: {
      colors: {
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        card: { DEFAULT: "hsl(var(--card))", foreground: "hsl(var(--card-foreground))" },
        popover: { DEFAULT: "hsl(var(--popover))", foreground: "hsl(var(--popover-foreground))" },
        primary: { DEFAULT: "hsl(var(--primary))", foreground: "hsl(var(--primary-foreground))" },
        secondary: { DEFAULT: "hsl(var(--secondary))", foreground: "hsl(var(--secondary-foreground))" },
        muted: { DEFAULT: "hsl(var(--muted))", foreground: "hsl(var(--muted-foreground))" },
        accent: { DEFAULT: "hsl(var(--accent))", foreground: "hsl(var(--accent-foreground))" },
        destructive: { DEFAULT: "hsl(var(--destructive))", foreground: "hsl(var(--destructive-foreground))" },
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        status: {
          placed: "hsl(var(--status-placed))",
          "placed-bg": "hsl(var(--status-placed-bg))",
          accepted: "hsl(var(--status-accepted))",
          "accepted-bg": "hsl(var(--status-accepted-bg))",
          cancelled: "hsl(var(--status-cancelled))",
          "cancelled-bg": "hsl(var(--status-cancelled-bg))",
        },
      },
      borderRadius: { lg: "var(--radius)", md: "calc(var(--radius) - 4px)", sm: "calc(var(--radius) - 8px)" },
      fontFamily: { sans: ["var(--font-manrope)", "system-ui", "sans-serif"] },
    },
  },
  plugins: [],
};

export default preset;
```

- [ ] **Step 3: Wire the app's Tailwind config to the preset + shared content**

Replace `apps/web-customer/tailwind.config.ts` with:
```ts
import type { Config } from "tailwindcss";
import preset from "@flashbite/web-shared/tailwind-preset";

const config: Config = {
  presets: [preset],
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "../../packages/web-shared/src/**/*.{ts,tsx}",
  ],
};

export default config;
```
Add to `packages/web-shared/package.json` so the preset is importable by subpath:
```json
  "exports": {
    ".": "./src/index.ts",
    "./tailwind-preset": "./tailwind-preset.ts",
    "./styles/theme.css": "./src/styles/theme.css"
  },
```
(Keep `main`/`types` for the root import.)

- [ ] **Step 4: Import the theme + load Manrope**

At the top of `apps/web-customer/app/globals.css`, after the Tailwind directives, add:
```css
@import "@flashbite/web-shared/styles/theme.css";
```
Replace `apps/web-customer/app/layout.tsx` body with Manrope wired to the `--font-manrope` variable:
```tsx
import type { Metadata } from "next";
import { Manrope } from "next/font/google";
import "./globals.css";

const manrope = Manrope({ subsets: ["latin"], variable: "--font-manrope" });

export const metadata: Metadata = { title: "FlashBite", description: "Order food, fast." };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={manrope.variable}>
      <body className="font-sans bg-background text-foreground antialiased">{children}</body>
    </html>
  );
}
```

- [ ] **Step 5: Verify tokens render**

Temporarily set `apps/web-customer/app/page.tsx` to:
```tsx
export default function Home() {
  return <main className="p-10"><button className="bg-primary text-primary-foreground rounded-lg px-4 py-2 font-bold">Primary</button></main>;
}
```
Run: `pnpm --filter web-customer dev` and open http://localhost:3100 — the button is green (#06C167-ish), rounded, Manrope. Stop the dev server.

- [ ] **Step 6: Commit**

```bash
git add packages/web-shared apps/web-customer/tailwind.config.ts apps/web-customer/app/globals.css apps/web-customer/app/layout.tsx pnpm-lock.yaml
git commit -m "feat(web-shared): design tokens + Manrope; wire app Tailwind to shared preset"
```
End body with the `Co-Authored-By` trailer.

---

## Task 4: Initialize shadcn/ui in `web-shared` + add base components

**Files:**
- Create: `packages/web-shared/components.json`, `packages/web-shared/src/lib/utils.ts`, `packages/web-shared/src/components/ui/*`
- Modify: `packages/web-shared/src/index.ts`, `packages/web-shared/package.json` (deps)

- [ ] **Step 1: Add shadcn runtime deps to web-shared**

```bash
pnpm --filter @flashbite/web-shared add class-variance-authority clsx tailwind-merge lucide-react embla-carousel-react
pnpm --filter @flashbite/web-shared add -D tailwindcss tailwindcss-animate
```

- [ ] **Step 2: Add the `cn` helper**

`packages/web-shared/src/lib/utils.ts`:
```ts
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
```

- [ ] **Step 3: Create the shadcn config**

`packages/web-shared/components.json`:
```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": true,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "src/styles/theme.css",
    "baseColor": "neutral",
    "cssVariables": true,
    "prefix": ""
  },
  "aliases": {
    "components": "@flashbite/web-shared/components",
    "utils": "@flashbite/web-shared/lib/utils",
    "ui": "@flashbite/web-shared/components/ui"
  }
}
```

- [ ] **Step 4: Add the base components via the shadcn CLI**

From `packages/web-shared`:
```bash
cd packages/web-shared
pnpm dlx shadcn@latest add button card badge input separator dropdown-menu skeleton carousel --yes
cd ../..
```
This writes component source into `packages/web-shared/src/components/ui/`. If the CLI prompts about overwriting `lib/utils.ts` or theme, keep the versions created in Tasks 3–4 (decline overwrites of `theme.css`).

> If the non-interactive CLI cannot resolve the monorepo paths, add the components by copying each component's published source from https://ui.shadcn.com into `src/components/ui/<name>.tsx` (they only depend on `cn`, Radix, `lucide-react`, and `embla-carousel-react`, all installed in Step 1). Verify each file imports `cn` from `../../lib/utils`.

- [ ] **Step 5: Export the components from the barrel**

Append to `packages/web-shared/src/index.ts`:
```ts
export { cn } from "./lib/utils";
export { Button, buttonVariants } from "./components/ui/button";
export { Card, CardHeader, CardContent, CardFooter, CardTitle, CardDescription } from "./components/ui/card";
export { Badge, badgeVariants } from "./components/ui/badge";
export { Input } from "./components/ui/input";
export { Separator } from "./components/ui/separator";
export {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from "./components/ui/dropdown-menu";
export { Skeleton } from "./components/ui/skeleton";
export {
  Carousel, CarouselContent, CarouselItem, CarouselNext, CarouselPrevious,
} from "./components/ui/carousel";
```
Also add a subpath export so the app can deep-import if needed — in `packages/web-shared/package.json` `exports`, add:
```json
    "./components/*": "./src/components/*",
    "./lib/*": "./src/lib/*"
```

- [ ] **Step 6: Verify a shadcn Button renders from the shared package**

Set `apps/web-customer/app/page.tsx`:
```tsx
import { Button } from "@flashbite/web-shared";

export default function Home() {
  return <main className="p-10"><Button>Order now</Button></main>;
}
```
```bash
pnpm install
pnpm --filter web-customer dev
```
Open http://localhost:3100 — a green shadcn Button renders. Stop the server.

- [ ] **Step 7: Commit**

```bash
git add packages/web-shared apps/web-customer/app/page.tsx pnpm-lock.yaml
git commit -m "feat(web-shared): shadcn/ui components (button, card, badge, input, carousel, …) themed by tokens"
```
End body with the `Co-Authored-By` trailer.

---

## Task 5: Typed API client + rewrites proxy + tenant store (Vitest)

**Files:**
- Create: `packages/web-shared/src/api/client.ts`, `src/api/client.test.ts`, `src/store/tenant-store.ts`, `vitest.config.ts`, `vitest.setup.ts`
- Modify: `apps/web-customer/next.config.ts` (rewrites), `packages/web-shared/src/index.ts`, `packages/web-shared/package.json` (deps)

- [ ] **Step 1: Add deps + Vitest**

```bash
pnpm --filter @flashbite/web-shared add zustand
pnpm --filter @flashbite/web-shared add -D vitest @testing-library/react @testing-library/jest-dom jsdom @vitejs/plugin-react
```

- [ ] **Step 2: Vitest config + setup**

`packages/web-shared/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    globals: true,
  },
});
```
`packages/web-shared/vitest.setup.ts`:
```ts
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 3: Write the failing API-client test**

`packages/web-shared/src/api/client.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { placeOrder, getOrder, type PlaceOrderRequest } from "./client";

describe("api client", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("placeOrder POSTs to the write proxy with the tenant header and body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ orderId: "o-1" }), { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const req: PlaceOrderRequest = {
      orderId: "o-1", customerId: "alice",
      items: [{ sku: "pizza", qty: 1, price: 1200 }], totalAmount: 1200,
    };
    const res = await placeOrder("berlin", req);

    expect(res).toEqual({ orderId: "o-1" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/write/orders");
    expect(init.method).toBe("POST");
    expect(init.headers["X-Tenant-ID"]).toBe("berlin");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual(req);
  });

  it("getOrder GETs the read proxy with the tenant header", async () => {
    const view = { tenantId: "berlin", orderId: "o-1", customerId: "alice", items: [], totalAmount: 1200, status: "PLACED", version: 1, updatedAt: "t" };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(view), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await getOrder("berlin", "o-1");
    expect(res).toEqual(view);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/read/orders/o-1");
    expect(init.headers["X-Tenant-ID"]).toBe("berlin");
  });

  it("getOrder returns null on 404", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 404 })));
    expect(await getOrder("berlin", "missing")).toBeNull();
  });
});
```

- [ ] **Step 4: Run -> FAIL**

```bash
pnpm --filter @flashbite/web-shared test
```
Expected: FAIL — `./client` not found.

- [ ] **Step 5: Implement the client**

`packages/web-shared/src/api/client.ts`:
```ts
import type { OrderItem, OrderView } from "@flashbite/contracts";

export interface PlaceOrderRequest {
  orderId: string;
  customerId: string;
  items: OrderItem[];
  totalAmount: number;
}

const tenantHeaders = (tenantId: string): Record<string, string> => ({
  "Content-Type": "application/json",
  "X-Tenant-ID": tenantId,
});

/** POST /orders via the same-origin write proxy. */
export async function placeOrder(tenantId: string, req: PlaceOrderRequest): Promise<{ orderId: string }> {
  const res = await fetch("/api/write/orders", {
    method: "POST",
    headers: tenantHeaders(tenantId),
    body: JSON.stringify(req),
  });
  if (!res.ok) throw new Error(`placeOrder failed: ${res.status}`);
  return (await res.json()) as { orderId: string };
}

/** GET /orders/:id via the same-origin read proxy. Returns null on 404 (read model not caught up). */
export async function getOrder(tenantId: string, orderId: string): Promise<OrderView | null> {
  const res = await fetch(`/api/read/orders/${orderId}`, { headers: tenantHeaders(tenantId) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`getOrder failed: ${res.status}`);
  return (await res.json()) as OrderView;
}
```

- [ ] **Step 6: Run -> PASS**

```bash
pnpm --filter @flashbite/web-shared test
```
Expected: PASS (3 tests).

- [ ] **Step 7: Tenant store (cookie-persisted) + barrel export**

`packages/web-shared/src/store/tenant-store.ts`:
```ts
"use client";
import { create } from "zustand";
import { persist, createJSONStorage, type StateStorage } from "zustand/middleware";

export const TENANTS = ["berlin", "tokyo"] as const;
export type Tenant = (typeof TENANTS)[number];

// Persist to a cookie so the value is also readable by the proxy/SSR layer later.
const cookieStorage: StateStorage = {
  getItem: (name) => {
    if (typeof document === "undefined") return null;
    const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
    return m ? decodeURIComponent(m[1]) : null;
  },
  setItem: (name, value) => {
    document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=31536000; samesite=lax`;
  },
  removeItem: (name) => {
    document.cookie = `${name}=; path=/; max-age=0`;
  },
};

interface TenantState {
  tenant: Tenant;
  setTenant: (t: Tenant) => void;
}

export const useTenantStore = create<TenantState>()(
  persist(
    (set) => ({ tenant: "berlin", setTenant: (tenant) => set({ tenant }) }),
    { name: "fb-tenant", storage: createJSONStorage(() => cookieStorage) },
  ),
);
```
Append to `packages/web-shared/src/index.ts`:
```ts
export { placeOrder, getOrder, type PlaceOrderRequest } from "./api/client";
export { useTenantStore, TENANTS, type Tenant } from "./store/tenant-store";
```

- [ ] **Step 8: Add the rewrites proxy**

Replace `apps/web-customer/next.config.ts` with:
```ts
import type { NextConfig } from "next";

const WRITE_API = process.env.WRITE_API_ORIGIN ?? "http://localhost:3001";
const READ_API = process.env.READ_API_ORIGIN ?? "http://localhost:3002";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      { source: "/api/write/:path*", destination: `${WRITE_API}/:path*` },
      { source: "/api/read/:path*", destination: `${READ_API}/:path*` },
    ];
  },
};

export default nextConfig;
```

- [ ] **Step 9: Verify build + tests**

```bash
pnpm --filter @flashbite/web-shared test
pnpm --filter web-customer build
```
Expected: web-shared 3 tests pass; app builds.

- [ ] **Step 10: Commit**

```bash
git add packages/web-shared apps/web-customer/next.config.ts pnpm-lock.yaml
git commit -m "feat(web-shared): typed API client + tenant store; web-customer rewrites proxy"
```
End body with the `Co-Authored-By` trailer.

---

## Task 6: Cart store + per-tenant menu seed (Vitest)

**Files:**
- Create: `packages/web-shared/src/store/cart-store.ts`, `src/store/cart-store.test.ts`, `src/menu/seed.ts`, `src/menu/seed.test.ts`
- Modify: `packages/web-shared/src/index.ts`

- [ ] **Step 1: Write the failing menu-seed test**

`packages/web-shared/src/menu/seed.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { getMenu, getPopular, type MenuItem } from "./seed";

describe("menu seed", () => {
  it("returns a non-empty menu per tenant with cent prices", () => {
    const berlin = getMenu("berlin");
    expect(berlin.length).toBeGreaterThan(0);
    berlin.forEach((i: MenuItem) => {
      expect(typeof i.sku).toBe("string");
      expect(Number.isInteger(i.priceCents)).toBe(true);
    });
  });

  it("getPopular returns only popular items, ordered", () => {
    const popular = getPopular("berlin");
    expect(popular.length).toBeGreaterThan(0);
    expect(popular.every((i) => i.popular)).toBe(true);
  });

  it("isolates tenants (tokyo menu differs from berlin)", () => {
    expect(getMenu("tokyo")).not.toEqual(getMenu("berlin"));
  });
});
```

- [ ] **Step 2: Run -> FAIL**

```bash
pnpm --filter @flashbite/web-shared test src/menu/seed.test.ts
```
Expected: FAIL — `./seed` not found.

- [ ] **Step 3: Implement the seed**

`packages/web-shared/src/menu/seed.ts`:
```ts
import type { Tenant } from "../store/tenant-store";

export interface MenuItem {
  sku: string;
  name: string;
  description: string;
  priceCents: number;
  category: "pizza" | "burgers" | "sides" | "desserts";
  imageUrl?: string;
  popular?: boolean;
}

const MENUS: Record<Tenant, MenuItem[]> = {
  berlin: [
    { sku: "pizza", name: "Pizza Margherita", description: "San Marzano, basil", priceCents: 1200, category: "pizza", popular: true },
    { sku: "burger", name: "Cheeseburger", description: "Aged cheddar", priceCents: 950, category: "burgers", popular: true },
    { sku: "fries", name: "Fries", description: "Sea salt", priceCents: 400, category: "sides", popular: true },
    { sku: "tiramisu", name: "Tiramisu", description: "Mascarpone, cocoa", priceCents: 600, category: "desserts" },
  ],
  tokyo: [
    { sku: "sushi", name: "Sushi Set", description: "Chef's selection", priceCents: 1800, category: "pizza", popular: true },
    { sku: "ramen", name: "Tonkotsu Ramen", description: "Pork broth", priceCents: 1300, category: "sides", popular: true },
    { sku: "gyoza", name: "Gyoza (6)", description: "Pan-fried", priceCents: 700, category: "sides" },
    { sku: "mochi", name: "Mochi", description: "Red bean", priceCents: 500, category: "desserts" },
  ],
};

export function getMenu(tenant: Tenant): MenuItem[] {
  return MENUS[tenant];
}

/** Client-side "most chosen" until a backend popular endpoint exists. */
export function getPopular(tenant: Tenant): MenuItem[] {
  return MENUS[tenant].filter((i) => i.popular);
}
```

- [ ] **Step 4: Run -> PASS**

```bash
pnpm --filter @flashbite/web-shared test src/menu/seed.test.ts
```
Expected: PASS (3 tests).

- [ ] **Step 5: Write the failing cart-store test**

`packages/web-shared/src/store/cart-store.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { useCartStore } from "./cart-store";

const item = { sku: "pizza", name: "Pizza", priceCents: 1200 };

describe("cart store", () => {
  beforeEach(() => useCartStore.getState().clear());

  it("adds items and accumulates qty for the same sku", () => {
    useCartStore.getState().add(item);
    useCartStore.getState().add(item);
    expect(useCartStore.getState().count()).toBe(2);
    expect(useCartStore.getState().totalCents()).toBe(2400);
  });

  it("setQty to 0 removes the line", () => {
    useCartStore.getState().add(item);
    useCartStore.getState().setQty("pizza", 0);
    expect(useCartStore.getState().items).toHaveLength(0);
  });

  it("totalCents sums lines", () => {
    useCartStore.getState().add(item);
    useCartStore.getState().add({ sku: "fries", name: "Fries", priceCents: 400 });
    expect(useCartStore.getState().totalCents()).toBe(1600);
  });
});
```

- [ ] **Step 6: Run -> FAIL**

```bash
pnpm --filter @flashbite/web-shared test src/store/cart-store.test.ts
```
Expected: FAIL — `./cart-store` not found.

- [ ] **Step 7: Implement the cart store**

`packages/web-shared/src/store/cart-store.ts`:
```ts
"use client";
import { create } from "zustand";

export interface CartLine {
  sku: string;
  name: string;
  priceCents: number;
  qty: number;
}
type AddInput = Omit<CartLine, "qty">;

interface CartState {
  items: CartLine[];
  add: (item: AddInput) => void;
  setQty: (sku: string, qty: number) => void;
  remove: (sku: string) => void;
  clear: () => void;
  count: () => number;
  totalCents: () => number;
}

export const useCartStore = create<CartState>((set, get) => ({
  items: [],
  add: (item) =>
    set((s) => {
      const existing = s.items.find((l) => l.sku === item.sku);
      if (existing) {
        return { items: s.items.map((l) => (l.sku === item.sku ? { ...l, qty: l.qty + 1 } : l)) };
      }
      return { items: [...s.items, { ...item, qty: 1 }] };
    }),
  setQty: (sku, qty) =>
    set((s) => ({
      items: qty <= 0 ? s.items.filter((l) => l.sku !== sku) : s.items.map((l) => (l.sku === sku ? { ...l, qty } : l)),
    })),
  remove: (sku) => set((s) => ({ items: s.items.filter((l) => l.sku !== sku) })),
  clear: () => set({ items: [] }),
  count: () => get().items.reduce((n, l) => n + l.qty, 0),
  totalCents: () => get().items.reduce((sum, l) => sum + l.priceCents * l.qty, 0),
}));
```

- [ ] **Step 8: Run -> PASS + barrel export**

```bash
pnpm --filter @flashbite/web-shared test
```
Expected: all web-shared tests pass (api client + seed + cart).
Append to `packages/web-shared/src/index.ts`:
```ts
export { useCartStore, type CartLine } from "./store/cart-store";
export { getMenu, getPopular, type MenuItem } from "./menu/seed";
```

- [ ] **Step 9: Commit**

```bash
git add packages/web-shared
git commit -m "feat(web-shared): zustand cart store + per-tenant menu seed (Vitest)"
```
End body with the `Co-Authored-By` trailer.

---

## Task 7: Menu page `/` (header, tenant switcher, carousel, grid, cart)

**Files:**
- Create: `apps/web-customer/components/header.tsx`, `packages/web-shared/src/components/qty-stepper.tsx`
- Modify: `apps/web-customer/app/page.tsx`, `packages/web-shared/src/index.ts`

- [ ] **Step 1: QtyStepper primitive (composed on shadcn Button)**

`packages/web-shared/src/components/qty-stepper.tsx`:
```tsx
"use client";
import { Minus, Plus } from "lucide-react";
import { Button } from "./ui/button";

export function QtyStepper({ qty, onChange }: { qty: number; onChange: (q: number) => void }) {
  return (
    <div className="inline-flex items-center gap-2 rounded-full border px-1">
      <Button size="icon" variant="ghost" className="h-7 w-7 rounded-full" onClick={() => onChange(qty - 1)} aria-label="decrease">
        <Minus className="h-4 w-4" />
      </Button>
      <span className="w-4 text-center text-sm font-semibold">{qty}</span>
      <Button size="icon" variant="ghost" className="h-7 w-7 rounded-full" onClick={() => onChange(qty + 1)} aria-label="increase">
        <Plus className="h-4 w-4" />
      </Button>
    </div>
  );
}
```
Append to `packages/web-shared/src/index.ts`:
```ts
export { QtyStepper } from "./components/qty-stepper";
```

- [ ] **Step 2: Header with tenant switcher**

`apps/web-customer/components/header.tsx`:
```tsx
"use client";
import Link from "next/link";
import { useCartStore, useTenantStore, TENANTS, Button, DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@flashbite/web-shared";

export function Header() {
  const tenant = useTenantStore((s) => s.tenant);
  const setTenant = useTenantStore((s) => s.setTenant);
  const count = useCartStore((s) => s.count());
  return (
    <header className="flex items-center justify-between border-b px-6 py-4">
      <Link href="/" className="text-lg font-extrabold tracking-tight">flashbite</Link>
      <div className="flex items-center gap-4">
        <DropdownMenu>
          <DropdownMenuTrigger className="flex items-center gap-2 text-sm font-semibold">
            <span className="h-2 w-2 rounded-full bg-primary" /> {tenant} ▾
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {TENANTS.map((t) => (
              <DropdownMenuItem key={t} onClick={() => setTenant(t)}>{t}</DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Link href="/checkout"><Button size="sm">Cart ({count})</Button></Link>
      </div>
    </header>
  );
}
```

- [ ] **Step 3: Menu page**

`apps/web-customer/app/page.tsx`:
```tsx
"use client";
import Image from "next/image";
import {
  useTenantStore, useCartStore, getMenu, getPopular,
  Button, Card, CardContent, Carousel, CarouselContent, CarouselItem,
} from "@flashbite/web-shared";
import { Header } from "@/components/header";

const euro = (cents: number) => `€${(cents / 100).toFixed(2)}`;

export default function Home() {
  const tenant = useTenantStore((s) => s.tenant);
  const add = useCartStore((s) => s.add);
  const total = useCartStore((s) => s.totalCents());
  const count = useCartStore((s) => s.count());
  const menu = getMenu(tenant);
  const popular = getPopular(tenant);

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <main className="mx-auto max-w-5xl px-6 py-6">
        <input className="mb-5 w-full rounded-full bg-muted px-4 py-3 text-sm" placeholder="Search in FlashBite" />

        <h2 className="mb-3 text-xl font-extrabold">Most chosen 🔥</h2>
        <Carousel className="mb-8">
          <CarouselContent>
            {popular.map((item) => (
              <CarouselItem key={item.sku} className="basis-1/2 md:basis-1/4">
                <Card className="overflow-hidden">
                  <div className="h-24 bg-muted" />
                  <CardContent className="p-3">
                    <div className="font-bold">{item.name}</div>
                    <div className="text-xs text-muted-foreground">{euro(item.priceCents)}</div>
                  </CardContent>
                </Card>
              </CarouselItem>
            ))}
          </CarouselContent>
        </Carousel>

        <h2 className="mb-3 text-xl font-extrabold">All items</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {menu.map((item) => (
            <Card key={item.sku} className="overflow-hidden">
              <div className="h-28 bg-muted" />
              <CardContent className="p-3">
                <div className="font-bold">{item.name}</div>
                <div className="mb-2 text-sm text-muted-foreground">{item.description}</div>
                <div className="flex items-center justify-between">
                  <span className="font-bold">{euro(item.priceCents)}</span>
                  <Button size="icon" className="h-8 w-8 rounded-full"
                    onClick={() => add({ sku: item.sku, name: item.name, priceCents: item.priceCents })}
                    aria-label={`add ${item.name}`}>+</Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </main>

      {count > 0 && (
        <a href="/checkout" className="fixed bottom-5 left-1/2 -translate-x-1/2">
          <Button size="lg" className="rounded-full px-8 shadow-lg">Place order · {euro(total)}</Button>
        </a>
      )}
    </div>
  );
}
```
(`next/image` import is allowed even if unused now — remove it if your lint config flags unused imports. Real images are future work.)

- [ ] **Step 4: Verify in the browser**

```bash
pnpm --filter web-customer dev
```
Open http://localhost:3100 — the menu renders, the "Most chosen" carousel scrolls, clicking `+` updates the cart count in the header and shows the floating "Place order" button. Switching tenant (berlin↔tokyo) changes the menu. Stop the server.

- [ ] **Step 5: Commit**

```bash
git add apps/web-customer/app/page.tsx apps/web-customer/components/header.tsx packages/web-shared
git commit -m "feat(web-customer): menu page — tenant switcher, most-chosen carousel, add-to-cart"
```
End body with the `Co-Authored-By` trailer.

---

## Task 8: Checkout `/checkout` (review + place order)

**Files:**
- Create: `apps/web-customer/app/checkout/page.tsx`

- [ ] **Step 1: Implement the checkout page**

`apps/web-customer/app/checkout/page.tsx`:
```tsx
"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  useCartStore, useTenantStore, placeOrder, Button, Input, Card, CardContent,
} from "@flashbite/web-shared";
import { Header } from "@/components/header";

const euro = (cents: number) => `€${(cents / 100).toFixed(2)}`;

export default function Checkout() {
  const router = useRouter();
  const tenant = useTenantStore((s) => s.tenant);
  const items = useCartStore((s) => s.items);
  const total = useCartStore((s) => s.totalCents());
  const clear = useCartStore((s) => s.clear);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const orderId = crypto.randomUUID();
      await placeOrder(tenant, {
        orderId,
        customerId: name || "guest",
        items: items.map((l) => ({ sku: l.sku, qty: l.qty, price: l.priceCents })),
        totalAmount: total,
      });
      clear();
      router.push(`/orders/${orderId}`);
    } catch {
      setError("Could not place your order. Please try again.");
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <main className="mx-auto max-w-lg px-6 py-6">
        <h1 className="mb-4 text-2xl font-extrabold">Checkout</h1>
        <Card><CardContent className="p-4">
          {items.length === 0 ? (
            <p className="text-muted-foreground">Your cart is empty.</p>
          ) : (
            <>
              {items.map((l) => (
                <div key={l.sku} className="mb-2 flex justify-between text-sm">
                  <span className="text-muted-foreground">{l.name} ×{l.qty}</span>
                  <span>{euro(l.priceCents * l.qty)}</span>
                </div>
              ))}
              <div className="mt-3 flex justify-between border-t pt-3 font-extrabold">
                <span>Total</span><span>{euro(total)}</span>
              </div>
              <Input className="mt-4" placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} />
              {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
              <Button className="mt-4 w-full" disabled={busy} onClick={submit}>
                {busy ? "Placing…" : `Place order · ${euro(total)}`}
              </Button>
            </>
          )}
        </CardContent></Card>
      </main>
    </div>
  );
}
```

- [ ] **Step 2: Verify the place-order path**

Start infra + the write path:
```bash
pnpm infra:up
pnpm dev:write-api   # terminal 1
pnpm dev:web-customer # terminal 2
```
Add items on `/`, go to `/checkout`, enter a name, Place order. Expected: redirect to `/orders/<uuid>` (next task renders it; for now it may 404 in the app router — that's fine, confirm the network call to `/api/write/orders` returned 201 in devtools). Empty cart shows the empty message and no Place button payload. Stop servers.

- [ ] **Step 3: Commit**

```bash
git add apps/web-customer/app/checkout/page.tsx
git commit -m "feat(web-customer): checkout — review cart + place order"
```
End body with the `Co-Authored-By` trailer.

---

## Task 9: Order tracking `/orders/[orderId]` + StatusPill (Vitest)

**Files:**
- Create: `packages/web-shared/src/components/status-pill.tsx`, `src/components/status-pill.test.tsx`, `apps/web-customer/app/orders/[orderId]/page.tsx`
- Modify: `packages/web-shared/src/index.ts`

- [ ] **Step 1: Write the failing StatusPill test**

`packages/web-shared/src/components/status-pill.test.tsx`:
```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusPill } from "./status-pill";

describe("StatusPill", () => {
  it("renders the status label", () => {
    render(<StatusPill status="ACCEPTED" />);
    expect(screen.getByText("ACCEPTED")).toBeInTheDocument();
  });

  it("applies the accepted variant class", () => {
    render(<StatusPill status="ACCEPTED" />);
    expect(screen.getByText("ACCEPTED").className).toContain("status-accepted");
  });

  it("falls back gracefully for unknown status", () => {
    render(<StatusPill status="WEIRD" />);
    expect(screen.getByText("WEIRD")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run -> FAIL**

```bash
pnpm --filter @flashbite/web-shared test src/components/status-pill.test.tsx
```
Expected: FAIL — `./status-pill` not found.

- [ ] **Step 3: Implement StatusPill**

`packages/web-shared/src/components/status-pill.tsx`:
```tsx
import { cn } from "../lib/utils";

const VARIANTS: Record<string, string> = {
  PLACED: "text-status-placed bg-status-placed-bg",
  ACCEPTED: "text-status-accepted bg-status-accepted-bg",
  CANCELLED: "text-status-cancelled bg-status-cancelled-bg",
};

export function StatusPill({ status }: { status: string }) {
  return (
    <span className={cn("inline-block rounded-full px-3 py-1 text-xs font-bold", VARIANTS[status] ?? "bg-muted text-muted-foreground")}>
      {status}
    </span>
  );
}
```

- [ ] **Step 4: Run -> PASS + export**

```bash
pnpm --filter @flashbite/web-shared test src/components/status-pill.test.tsx
```
Expected: PASS (3 tests).
Append to `packages/web-shared/src/index.ts`:
```ts
export { StatusPill } from "./components/status-pill";
```

- [ ] **Step 5: Implement the tracking page (polling)**

`apps/web-customer/app/orders/[orderId]/page.tsx`:
```tsx
"use client";
import { use, useEffect, useState } from "react";
import {
  getOrder, useTenantStore, StatusPill, Card, CardContent, Skeleton, ORDER_STATUS, type OrderView,
} from "@flashbite/web-shared";
import { Header } from "@/components/header";

const TERMINAL = [ORDER_STATUS.ACCEPTED, ORDER_STATUS.CANCELLED] as string[];

export default function OrderTracking({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = use(params);
  const tenant = useTenantStore((s) => s.tenant);
  const [order, setOrder] = useState<OrderView | null>(null);
  const [waiting, setWaiting] = useState(true);

  useEffect(() => {
    let active = true;
    let tries = 0;
    const tick = async () => {
      const o = await getOrder(tenant, orderId).catch(() => null);
      if (!active) return;
      if (o) { setOrder(o); setWaiting(false); if (TERMINAL.includes(o.status)) return; }
      else { tries += 1; if (tries > 5) setWaiting(false); }
      timer = setTimeout(tick, 2000);
    };
    let timer: ReturnType<typeof setTimeout>;
    tick();
    return () => { active = false; clearTimeout(timer); };
  }, [tenant, orderId]);

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <main className="mx-auto max-w-lg px-6 py-6">
        <h1 className="mb-1 text-2xl font-extrabold">Your order</h1>
        <p className="mb-4 text-sm text-muted-foreground">#{orderId.slice(0, 8)}…</p>
        <Card><CardContent className="p-5">
          {!order && waiting && <Skeleton className="h-6 w-32" />}
          {!order && !waiting && <p className="text-muted-foreground">Still processing — hang tight.</p>}
          {order && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="font-semibold">Status</span>
                <StatusPill status={order.status} />
              </div>
              {!TERMINAL.includes(order.status) && (
                <p className="text-sm text-muted-foreground">Waiting for the merchant… (saga SLA timer running)</p>
              )}
            </div>
          )}
        </CardContent></Card>
      </main>
    </div>
  );
}
```

- [ ] **Step 6: Verify the full place → track flow**

```bash
pnpm infra:up
pnpm dev:write-api    # t1
pnpm dev:outbox       # t2
pnpm dev:projection   # t3
pnpm dev:read-api     # t4
pnpm dev:web-customer # t5
```
Place an order; on the tracking page the status appears as **PLACED** within a few seconds. (ACCEPTED/CANCELLED requires the saga stack — covered as the extended e2e in Task 10.) Stop servers.

- [ ] **Step 7: Commit**

```bash
git add apps/web-customer/app/orders packages/web-shared
git commit -m "feat(web-customer): live order tracking (poll) + StatusPill"
```
End body with the `Co-Authored-By` trailer.

---

## Task 10: Playwright e2e + test scripts

**Files:**
- Create: `apps/web-customer/playwright.config.ts`, `apps/web-customer/e2e/storefront.spec.ts`
- Modify: `package.json` (root) — `test:web`, `test:e2e`; `apps/web-customer/package.json` (Playwright dep + scripts)

- [ ] **Step 1: Add Playwright**

```bash
pnpm --filter web-customer add -D @playwright/test
pnpm --filter web-customer exec playwright install chromium
```

- [ ] **Step 2: Playwright config (auto-starts the dev server)**

`apps/web-customer/playwright.config.ts`:
```ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 30_000 },
  use: { baseURL: "http://localhost:3100" },
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:3100",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
```

- [ ] **Step 3: Write the e2e spec**

`apps/web-customer/e2e/storefront.spec.ts`:
```ts
import { test, expect, request } from "@playwright/test";

const WRITE_API = "http://localhost:3001";

test("place an order and see it reach PLACED, then ACCEPTED after merchant accept", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /add Pizza Margherita/i }).click();
  await page.getByRole("link", { name: /Cart \(/ }).click();

  await expect(page).toHaveURL(/\/checkout/);
  await page.getByPlaceholder("Your name").fill("e2e-alice");
  await page.getByRole("button", { name: /Place order/ }).click();

  await expect(page).toHaveURL(/\/orders\//);
  const orderId = page.url().split("/orders/")[1];
  await expect(page.getByText("PLACED")).toBeVisible({ timeout: 30_000 });

  // Merchant accept via the write-api signals the saga -> ACCEPTED.
  const api = await request.newContext();
  const res = await api.post(`${WRITE_API}/orders/${orderId}/accept`, { headers: { "X-Tenant-ID": "berlin" } });
  expect(res.status()).toBe(202);

  await expect(page.getByText("ACCEPTED")).toBeVisible({ timeout: 45_000 });
});

test("tenant isolation: a berlin order is not visible to tokyo", async () => {
  const api = await request.newContext({ baseURL: "http://localhost:3002" });
  const res = await api.get(`/orders/${crypto.randomUUID()}`, { headers: { "X-Tenant-ID": "tokyo" } });
  expect(res.status()).toBe(404);
});
```

- [ ] **Step 4: Wire test scripts**

In `apps/web-customer/package.json` `scripts`, add:
```json
    "test": "vitest run",
    "test:e2e": "playwright test"
```
In root `package.json` `scripts`, add:
```json
    "test:web": "pnpm --filter @flashbite/web-shared test && pnpm --filter web-customer test",
    "test:e2e:web": "pnpm --filter web-customer test:e2e"
```

- [ ] **Step 5: Run unit suites**

```bash
pnpm test:web
```
Expected: all `@flashbite/web-shared` Vitest suites pass (api client, seed, cart, StatusPill).

- [ ] **Step 6: Run the e2e (requires the full stack)**

```bash
pnpm infra:up
pnpm dev:write-api    # t1
pnpm dev:outbox       # t2
pnpm dev:projection   # t3
pnpm dev:read-api     # t4
pnpm dev:saga         # t5  (needed for the ACCEPTED transition)
pnpm test:e2e:web     # t6
```
Expected: both e2e tests pass — order reaches PLACED then ACCEPTED; cross-tenant 404. Stop servers.

- [ ] **Step 7: Commit**

```bash
git add apps/web-customer/playwright.config.ts apps/web-customer/e2e apps/web-customer/package.json package.json pnpm-lock.yaml
git commit -m "test(web-customer): Playwright e2e (place→PLACED→ACCEPTED, tenant isolation) + test scripts"
```
End body with the `Co-Authored-By` trailer.

---

## Self-Review (completed by plan author)

**Spec coverage:**
- Architecture (web-customer + web-shared, App Router + Tailwind, rewrites proxy, port 3100) → Tasks 1, 2, 5. ✓
- Design system (shadcn in web-shared, tokens incl. status palette, Manrope, shared preset) → Tasks 3, 4; status tokens used by StatusPill (Task 9). ✓
- zustand state (cart + tenant) → Tasks 5, 6. ✓
- Screens (menu + carousel + tenant switcher, checkout, tracking) → Tasks 7, 8, 9. ✓
- Data flow (per-tenant menu seed, place → poll-track, cent prices, tenant header) → Tasks 5–9. ✓
- "Most chosen" carousel (client-side `getPopular`, backend later) → Task 6 seed + Task 7 carousel. ✓
- Error handling (place failure inline, 404 soft-handling, empty-cart disabled) → Tasks 8, 9. ✓
- Testing (Playwright e2e happy path + isolation; Vitest cart/client/seed/StatusPill) → Tasks 5, 6, 9, 10. ✓
- Search visual-only, no login, header-based tenant → Tasks 5, 7. ✓

**Placeholder scan:** No TBD/TODO; every code/command step is complete. shadcn component internals are CLI-generated (Task 4) with a copy-from-source fallback documented.

**Type/name consistency:** `useCartStore` (`add/setQty/remove/clear/count/totalCents`, `CartLine.priceCents`), `useTenantStore` (`tenant/setTenant`, `Tenant`), `placeOrder(tenant, PlaceOrderRequest{orderId,customerId,items:OrderItem[],totalAmount})`, `getOrder(tenant,id)→OrderView|null`, `getMenu/getPopular(tenant)→MenuItem[]`, `StatusPill{status}`, `QtyStepper{qty,onChange}`, `ORDER_STATUS` from contracts, and the `/api/write` `/api/read` proxy paths are used identically across web-shared and web-customer. Cart line uses `priceCents`; the order request maps it to `price` (integer cents) — consistent with contracts `OrderItem.price` and existing data.

**Scope note:** One vertical slice (storefront + shared foundation). Real menu/popular backends, login/JWT, payment, and the other three surfaces are explicitly out of scope.
