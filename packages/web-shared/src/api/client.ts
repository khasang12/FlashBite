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

/** POST /orders via the same-origin write proxy. */
export async function placeOrder(req: PlaceOrderRequest): Promise<{ orderId: string }> {
  const res = await fetch("/api/write/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: JSON.stringify(req),
  });
  if (!res.ok) throw new Error(`placeOrder failed: ${res.status}`);
  return (await res.json()) as { orderId: string };
}

/** GET /orders/:id via the same-origin read proxy. Returns null on 404 (read model not caught up). */
export async function getOrder(orderId: string): Promise<OrderView | null> {
  const res = await fetch(`/api/read/orders/${encodeURIComponent(orderId)}`, { headers: authHeader() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`getOrder failed: ${res.status}`);
  return (await res.json()) as OrderView;
}

/** GET /merchant/orders via the same-origin read proxy. Returns all orders for the tenant. */
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

/**
 * POST /drivers/:id/location — telemetry ingest. Intentionally on the READ proxy:
 * the ingest endpoint is served by read-api (:3002), not write-api.
 */
export async function reportLocation(driverId: string, body: ReportLocationBody): Promise<{ driverId: string }> {
  const res = await fetch(`/api/read/drivers/${encodeURIComponent(driverId)}/location`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`reportLocation failed: ${res.status}`);
  return (await res.json()) as { driverId: string };
}

/** GET /drivers/nearby via the same-origin read proxy. Distance-sorted ascending. */
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
