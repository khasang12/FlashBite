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
