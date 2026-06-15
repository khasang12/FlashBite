import type { OrderItem, OrderView } from "@flashbite/contracts";

export interface PlaceOrderRequest {
  orderId: string;
  customerId: string;
  items: OrderItem[];
  totalAmount: number;
}

const tenantHeader = (tenantId: string): Record<string, string> => ({ "X-Tenant-ID": tenantId });

/** POST /orders via the same-origin write proxy. */
export async function placeOrder(
  tenantId: string,
  req: PlaceOrderRequest,
): Promise<{ orderId: string }> {
  const res = await fetch("/api/write/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...tenantHeader(tenantId) },
    body: JSON.stringify(req),
  });
  if (!res.ok) throw new Error(`placeOrder failed: ${res.status}`);
  return (await res.json()) as { orderId: string };
}

/** GET /orders/:id via the same-origin read proxy. Returns null on 404 (read model not caught up). */
export async function getOrder(
  tenantId: string,
  orderId: string,
): Promise<OrderView | null> {
  const res = await fetch(`/api/read/orders/${encodeURIComponent(orderId)}`, {
    headers: tenantHeader(tenantId),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`getOrder failed: ${res.status}`);
  return (await res.json()) as OrderView;
}

/** GET /merchant/orders via the same-origin read proxy. Returns all orders for the tenant. */
export async function listOrders(tenantId: string): Promise<OrderView[]> {
  const res = await fetch("/api/read/merchant/orders", { headers: tenantHeader(tenantId) });
  if (!res.ok) throw new Error(`listOrders failed: ${res.status}`);
  return (await res.json()) as OrderView[];
}

async function signalOrder(tenantId: string, orderId: string, action: "accept" | "decline"): Promise<void> {
  const res = await fetch(`/api/write/orders/${encodeURIComponent(orderId)}/${action}`, {
    method: "POST",
    headers: tenantHeader(tenantId),
  });
  if (!res.ok) throw new Error(`${action}Order failed: ${res.status}`);
}

export function acceptOrder(tenantId: string, orderId: string): Promise<void> {
  return signalOrder(tenantId, orderId, "accept");
}
export function declineOrder(tenantId: string, orderId: string): Promise<void> {
  return signalOrder(tenantId, orderId, "decline");
}

export interface NearbyDriver {
  driverId: string;
  distanceKm: number;
  lng: number;
  lat: number;
}

export interface ReportLocationBody {
  lng: number;
  lat: number;
  orderId?: string;
}

/**
 * POST /drivers/:id/location — telemetry ingest. Intentionally on the READ proxy:
 * the ingest endpoint is served by read-api (:3002), not write-api.
 */
export async function reportLocation(
  tenantId: string,
  driverId: string,
  body: ReportLocationBody,
): Promise<{ driverId: string }> {
  const res = await fetch(`/api/read/drivers/${encodeURIComponent(driverId)}/location`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...tenantHeader(tenantId) },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`reportLocation failed: ${res.status}`);
  return (await res.json()) as { driverId: string };
}

/** GET /drivers/nearby via the same-origin read proxy. Distance-sorted ascending. */
export async function getNearbyDrivers(
  tenantId: string,
  lng: number,
  lat: number,
  radiusKm = 5,
): Promise<NearbyDriver[]> {
  const qs = new URLSearchParams({ lng: String(lng), lat: String(lat), radiusKm: String(radiusKm) });
  const res = await fetch(`/api/read/drivers/nearby?${qs.toString()}`, {
    headers: tenantHeader(tenantId),
  });
  if (!res.ok) throw new Error(`getNearbyDrivers failed: ${res.status}`);
  return (await res.json()) as NearbyDriver[];
}
