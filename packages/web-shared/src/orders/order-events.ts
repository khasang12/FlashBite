import { EVENT_TYPES, ORDER_STATUS, type OrderView } from "@flashbite/contracts";

export interface OrderStreamEvent {
  orderId: string;
  eventType: string;
  cancelReason?: string;
}

/** The SSE feeder hardcodes `status`, so derive the real status from the event type. */
export function statusFromEventType(eventType: string): string | null {
  switch (eventType) {
    case EVENT_TYPES.ORDER_PLACED: return ORDER_STATUS.PLACED;
    case EVENT_TYPES.ORDER_ACCEPTED: return ORDER_STATUS.ACCEPTED;
    case EVENT_TYPES.ORDER_CANCELLED: return ORDER_STATUS.CANCELLED;
    default: return null;
  }
}

/** Insert or replace an order by id, keeping newest-first (by updatedAt desc). */
export function upsertOrder(rows: OrderView[], order: OrderView): OrderView[] {
  const without = rows.filter((r) => r.orderId !== order.orderId);
  return [order, ...without].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

/** Apply a live SSE event to existing rows: update a known order's status in place.
 *  Unknown orders are left unchanged — the caller fetches their detail and upserts. */
export function applyOrderEvent(rows: OrderView[], event: OrderStreamEvent): OrderView[] {
  const status = statusFromEventType(event.eventType);
  if (!status) return rows;
  if (!rows.some((r) => r.orderId === event.orderId)) return rows;
  return rows.map((r) =>
    r.orderId === event.orderId
      ? { ...r, status, ...(event.cancelReason ? { cancelReason: event.cancelReason } : {}) }
      : r,
  );
}
