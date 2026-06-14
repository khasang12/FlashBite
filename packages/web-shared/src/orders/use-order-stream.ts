"use client";
import { useEffect, useRef } from "react";
import { fetchEventSource } from "@microsoft/fetch-event-source";
import type { OrderStreamEvent } from "./order-events";

/** Pure parser for one SSE `data` payload. Exported for tests. */
export function parseStreamData(data: string): OrderStreamEvent | null {
  try {
    const o = JSON.parse(data) as Partial<OrderStreamEvent>;
    if (typeof o.orderId === "string" && typeof o.eventType === "string") {
      return { orderId: o.orderId, eventType: o.eventType };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Subscribes to the merchant SSE stream via the same-origin rewrite. Uses
 * fetch-based SSE (not EventSource) so the X-Tenant-ID header can be sent.
 * Calls `onEvent` for each parsed event; auto-reconnects; `onOpen` fires on
 * (re)connect so the caller can resync the list.
 */
export function useOrderStream(
  tenantId: string,
  onEvent: (e: OrderStreamEvent) => void,
  onOpen?: () => void,
): void {
  const onEventRef = useRef(onEvent);
  const onOpenRef = useRef(onOpen);
  onEventRef.current = onEvent;
  onOpenRef.current = onOpen;

  useEffect(() => {
    const ctrl = new AbortController();
    void fetchEventSource("/api/read/merchant/orders/stream", {
      headers: { "X-Tenant-ID": tenantId },
      signal: ctrl.signal,
      openWhenHidden: true,
      onopen: async (_response: Response) => { onOpenRef.current?.(); },
      onmessage: (msg) => {
        const parsed = parseStreamData(msg.data);
        if (parsed) onEventRef.current(parsed);
      },
    }).catch(() => { /* aborted on unmount */ });
    return () => ctrl.abort();
  }, [tenantId]);
}
