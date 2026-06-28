"use client";
import { useEffect, useRef } from "react";
import { fetchEventSource } from "@microsoft/fetch-event-source";
import type { OrderStreamEvent } from "./order-events";
import { useAuthStore } from "../store/auth-store";
import { refreshAuthSession } from "../api/client";

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
 * Subscribes to an order SSE stream via the same-origin rewrite. Uses
 * fetch-based SSE (not EventSource) so the Authorization header can be sent.
 * Calls `onEvent` for each parsed event; auto-reconnects; `onOpen` fires on
 * (re)connect so the caller can resync the list.
 * Pass `path` to point at the admin cross-tenant stream instead of the default
 * merchant stream.
 */
export function useOrderStream(
  onEvent: (e: OrderStreamEvent) => void,
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
      onopen: async (response: Response) => {
        if (response.status === 401) {
          // Try to refresh an expired access token before ending the session; only log out if that
          // fails. A successful refresh changes the store token, re-running this effect to reconnect.
          const ok = await refreshAuthSession();
          if (!ok) useAuthStore.getState().logout(); // token cleared -> effect tears down; AuthGate -> login
          throw new Error("unauthorized"); // stop this stale-token connection
        }
        onOpenRef.current?.();
      },
      onmessage: (msg) => {
        const parsed = parseStreamData(msg.data);
        if (parsed) onEventRef.current(parsed);
      },
      onerror: (err) => {
        if (err instanceof Error && err.message === "unauthorized") throw err; // don't retry with a stale token
        /* transient network error: let fetchEventSource retry */
      },
    }).catch(() => { /* aborted on unmount */ });
    return () => ctrl.abort();
  }, [token, path]);
}
