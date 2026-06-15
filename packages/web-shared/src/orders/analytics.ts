import { ORDER_STATUS, type OrderView } from "@flashbite/contracts";

const live = (o: OrderView): boolean => o.status !== ORDER_STATUS.CANCELLED;
const tenantsOf = (orders: OrderView[]): string[] => [...new Set(orders.map((o) => o.tenantId))];

/** Total GMV: sum of totalAmount over non-cancelled orders. */
export function aggregateGmv(orders: OrderView[]): number {
  return orders.filter(live).reduce((s, o) => s + o.totalAmount, 0);
}

export interface TenantGmv { tenant: string; gmv: number; }
export function gmvByTenant(orders: OrderView[]): TenantGmv[] {
  return tenantsOf(orders).map((tenant) => ({
    tenant,
    gmv: orders.filter((o) => o.tenantId === tenant && live(o)).reduce((s, o) => s + o.totalAmount, 0),
  }));
}

export interface TenantStatusCounts { tenant: string; placed: number; accepted: number; cancelled: number; }
export function statusBreakdown(orders: OrderView[]): TenantStatusCounts[] {
  return tenantsOf(orders).map((tenant) => {
    const rows = orders.filter((o) => o.tenantId === tenant);
    return {
      tenant,
      placed: rows.filter((o) => o.status === ORDER_STATUS.PLACED).length,
      accepted: rows.filter((o) => o.status === ORDER_STATUS.ACCEPTED).length,
      cancelled: rows.filter((o) => o.status === ORDER_STATUS.CANCELLED).length,
    };
  });
}

export interface SkuCount { sku: string; qty: number; }
export function topSkus(orders: OrderView[], limit = 5): SkuCount[] {
  const totals = new Map<string, number>();
  for (const o of orders.filter(live)) {
    for (const it of o.items ?? []) totals.set(it.sku, (totals.get(it.sku) ?? 0) + it.qty);
  }
  return [...totals.entries()]
    .map(([sku, qty]) => ({ sku, qty }))
    .sort((a, b) => b.qty - a.qty || a.sku.localeCompare(b.sku))
    .slice(0, limit);
}

export interface GmvBucket { bucket: string; gmv: number; }
/** GMV bucketed by hour (UTC) of updatedAt, non-cancelled, ascending by bucket. */
export function gmvOverTime(orders: OrderView[]): GmvBucket[] {
  const totals = new Map<string, number>();
  for (const o of orders.filter(live)) {
    const bucket = o.updatedAt.slice(0, 13); // "YYYY-MM-DDTHH"
    totals.set(bucket, (totals.get(bucket) ?? 0) + o.totalAmount);
  }
  return [...totals.entries()]
    .map(([bucket, gmv]) => ({ bucket, gmv }))
    .sort((a, b) => (a.bucket < b.bucket ? -1 : 1));
}

export interface OrderCounts { total: number; cancelled: number; cancelRate: number; }
export function orderCounts(orders: OrderView[]): OrderCounts {
  const total = orders.length;
  const cancelled = orders.filter((o) => o.status === ORDER_STATUS.CANCELLED).length;
  return { total, cancelled, cancelRate: total === 0 ? 0 : cancelled / total };
}

/** Replace one tenant's orders within the merged list (used when a tenant snapshot reloads). */
export function replaceTenantOrders(all: OrderView[], tenant: string, incoming: OrderView[]): OrderView[] {
  return [...all.filter((o) => o.tenantId !== tenant), ...incoming];
}
