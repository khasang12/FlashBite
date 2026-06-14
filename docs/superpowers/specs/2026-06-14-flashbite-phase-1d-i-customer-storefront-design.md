# FlashBite Phase 1d-i — Customer Storefront (Design Spec)

**Date:** 2026-06-14
**Status:** Approved (pending spec review)
**Slice:** First of four Phase 1d frontend slices.

## Goal

A thin-but-presentable Next.js **customer storefront**: browse a menu, build a cart,
place an order, and watch its status resolve live (PLACED → ACCEPTED / CANCELLED) as the
Temporal saga runs. This slice also lays the **shared frontend foundation** (design system
+ API client) reused by the later surfaces.

## Phase 1d decomposition (context)

Phase 1d is four independent surfaces, each its own spec → plan → build cycle:

| Slice | Surface | Dep |
|------|---------|-----|
| **1d-i (this)** | Customer storefront + shared foundation | none |
| 1d-ii | Merchant dashboard (SSE queue, accept/decline) | foundation |
| 1d-iii | Driver view (GPS emit, nearby) | telemetry (PR #5) merged |
| 1d-iv | Admin grid (GMV, cross-tenant, driver canvas) | the others |

## Scope

**In:** menu browse (with a "Most chosen" carousel + category chips), cart, place order,
live order tracking, tenant switcher, the shared design system + UI primitives + typed API
client.

**Out (later / other slices):** real catalog/menu backend, login & JWT (Phase 2), payment,
merchant accept/decline UI (1d-ii), driver map (1d-iii/iv), i18n, real subdomain hosting.

## Architecture

- **`apps/web-customer`** — Next.js (App Router, TypeScript, Tailwind). Dev server on **3100**.
- **`packages/web-shared`** — created here, reused by all later surfaces. Exports:
  - **shadcn/ui component home** (MIT; Radix UI + Tailwind, owned source in-repo) + the
    **Tailwind preset** and **theme CSS variables** (design tokens — see Design System).
    Configured for monorepo use (`components.json`) so every surface consumes the same
    components and theme. This is the one bit of extra setup vs a single app.
  - **Typed API client**: `placeOrder(dto)`, `getOrder(id)` — thin `fetch` wrappers that attach `X-Tenant-ID` and target the same-origin proxy paths; re-exports `@flashbite/contracts` types (`CreateOrderDto`, `OrderView`, `OrderItem`, statuses).
  - **Menu seed**: static per-tenant menu data (see below).
  - **Tenant helper**: current-tenant accessor used by the API client.
- **CORS** — none added to the Nest APIs. `next.config` **rewrites** proxy the browser's
  same-origin calls: `/api/write/:path*` → `http://localhost:3001/:path*`,
  `/api/read/:path*` → `http://localhost:3002/:path*`. The browser only ever calls
  same-origin; this also sets up cleanly for server-side tokens in Phase 2.
- **Root scripts**: `dev:web-customer` (Next dev, port 3100). pnpm workspace + (if present)
  Turbo wiring so `web-shared` is consumed as `@flashbite/web-shared`.

## Design system

Influenced by common food-delivery UI patterns (UberEats/ShopeeFood): minimal, image-led,
generous whitespace, one accent. **Shipped under FlashBite's own branding** — no third-party
names, logos, or proprietary fonts in the product.

**Tokens** map onto **shadcn's theme CSS variables** (set once in the shared global stylesheet)
plus the Tailwind preset:
- `--primary` = accent `#06C167` (green) with white foreground; `--background` near-white,
  `--foreground`/`ink` `#000`; `--border` `#ECECEC`/`#F1F1F1`; muted text `#6B7280`/`#9CA3AF`.
- `--radius` tuned to the rounded look (cards ~16px, buttons ~10–12px; chips/pills/add-button full).
- Status semantics (custom tokens + Badge variants, reused on every surface):
  `placed` (amber on `#FFF7E6`), `accepted` (green on `#E7F9EF`), `cancelled` (red on `#FDECEC`).
- Type: **Manrope** (Google Fonts, OFL) as the `--font-sans` — a free analog for the
  proprietary Uber Move; geometric, tight-tracked headings, weights 400–800. Swappable later.
  Scale: display (~30/800), heading (~20/700), body (~15/500), label (~12 uppercase, tracked).

**Components** are **shadcn/ui** (owned source in `web-shared`), themed by the tokens above so
the storefront and later surfaces stay consistent:
- Direct from shadcn: `Button`, `Card`, `Badge`, `Input`, `Carousel` (Embla-based, for
  "Most chosen"), `Separator`, `DropdownMenu` (tenant switcher), `Skeleton` (loading/poll).
- Composed locally on top of shadcn: `QtyStepper` (two `Button`s + count), `StatusPill`
  (a `Badge` with `placed`/`accepted`/`cancelled` variants), category `Chip` (a `Button`
  variant). No bespoke primitives where shadcn already provides one.
- shadcn pulls in Radix UI, `class-variance-authority`, `tailwind-merge`/`clsx`, and
  `lucide-react` icons; the Carousel adds `embla-carousel-react`.

## Screens & routes

- **`/`** — Menu. Top bar (brand + tenant switcher), search field (visual only this slice),
  category chips, **"Most chosen" carousel**, menu grid of item cards (image, name, price,
  add / qty stepper), sticky cart summary with "Place order · €total".
- **`/checkout`** — order review, name field, Place order (calls the API).
- **`/orders/[orderId]`** — tracking: polls the read model, renders the status timeline
  (PLACED → ACCEPTED / CANCELLED) using the status tokens.
- **Tenant switcher** — header dropdown (berlin / tokyo), persisted in a cookie; drives the
  `X-Tenant-ID` header on every API call.

## State (zustand)

- **`useCartStore`** — `items[]`, `add(item)`, `remove(sku)`, `setQty(sku, n)`, derived
  `total` and `count`. Drives menu add buttons, cart summary, checkout.
- **`useTenantStore`** — `tenant`, `setTenant`, persisted to a cookie; read by the API client.

## Data flow

- **Menu seed** — static, keyed by tenant, in `web-shared`. Shape per item:
  `{ sku, name, description, priceCents, category, popular?: boolean }`. Tenants: `berlin`,
  `tokyo`. SKUs reuse the known set (pizza, burger, fries, …) so orders match existing data.
- **Place order** — client builds `CreateOrderDto`: `orderId = crypto.randomUUID()`, maps
  cart → `items[{ sku, qty, price }]` where `price` is the item's `priceCents` (integer
  cents, matching existing order data), computes `totalAmount = Σ(price × qty)` (cents).
  `POST /api/write/orders` with `X-Tenant-ID` → 201 `{ orderId }` → redirect to
  `/orders/[orderId]`, clear cart.
- **Tracking** — poll `GET /api/read/orders/:id` every ~2s; stop on `ACCEPTED` / `CANCELLED`
  or after a bounded number of attempts. Render the current status; show terminal outcome.

## Most-chosen carousel

Horizontal-scroll row above the menu grid. This slice ranks items client-side by the static
`popular` flag in the seed. A backend "popular"/analytics-driven endpoint is **future work**
(noted, not built here) — the component reads from a `getPopular()` shim so swapping the
source later is a one-line change.

## Error handling

- Place-order failure (validation / 5xx) → inline error on checkout, cart preserved.
- Tracking `404` (read model not yet caught up) → treat as "still processing", keep polling
  for a few cycles before surfacing a soft message.
- Empty cart → Place order disabled.
- API/network error in tracking → show a retry affordance; do not crash the page.

## Testing

- **Playwright e2e** (the payoff, against `pnpm infra:up` + dev services): tenant berlin →
  add items → place order → land on tracking → assert PLACED; trigger accept via write-api →
  assert ACCEPTED. A second path asserts the SLA/decline → CANCELLED outcome.
- **Vitest + Testing Library** (unit/component): `useCartStore` (totals/qty/remove), the API
  client (request shape + `X-Tenant-ID` header + proxy paths), and the `StatusPill` mapping.
- **Tenant isolation smoke**: an order placed under berlin returns 404 under tokyo.

## Open assumptions

- Tenant identity is header-based (`X-Tenant-ID`) until the Phase 2 identity service; the
  storefront selects tenant via the switcher, not a login.
- Merchant accept/decline is triggered via the existing write-api endpoints to demo tracking
  until the 1d-ii dashboard exists.
- Menu and "popular" are static seeds this slice; backends are explicit future work.
