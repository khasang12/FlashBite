"use client";
import { useEffect, useRef, useState } from "react";
import { fetchEventSource } from "@microsoft/fetch-event-source";
import type { DispatchView } from "@flashbite/contracts";
import { useAuthStore } from "../store/auth-store";

/** Pure parser for one SSE `data` payload into a DispatchView. Exported for tests. */
export function parseDispatchData(data: string): DispatchView | null {
  try {
    const o = JSON.parse(data) as Partial<DispatchView>;
    if (typeof o.orderId === "string" && typeof o.status === "string") return o as DispatchView;
    return null;
  } catch {
    return null;
  }
}

/** Reconcile the current dispatch view with an incoming one: a different order
 *  always wins; the same order only advances on a newer version. Exported for tests. */
export function reduceDispatch(prev: DispatchView | null, next: DispatchView): DispatchView {
  if (!prev || prev.orderId !== next.orderId) return next;
  return next.version >= prev.version ? next : prev;
}

/**
 * Subscribes to the driver dispatch SSE stream via the same-origin read proxy.
 * Fetch-based SSE so the Authorization header is sent. Returns the driver's
 * current dispatch view (offer or active job) and the connection state.
 */
export function useDispatchStream(driverId: string | undefined): { dispatch: DispatchView | null; connected: boolean } {
  const [dispatch, setDispatch] = useState<DispatchView | null>(null);
  const [connected, setConnected] = useState(false);
  const token = useAuthStore((s) => s.token);

  useEffect(() => {
    if (!token || !driverId) return;
    const ctrl = new AbortController();
    void fetchEventSource("/api/read/driver/dispatch/stream", {
      headers: { Authorization: `Bearer ${token}` },
      signal: ctrl.signal,
      openWhenHidden: true,
      onopen: async (response: Response) => {
        if (response.status === 401) {
          useAuthStore.getState().logout();
          throw new Error("unauthorized");
        }
        setConnected(true);
      },
      onmessage: (msg) => {
        const view = parseDispatchData(msg.data);
        if (view) setDispatch((prev) => reduceDispatch(prev, view));
      },
      onerror: () => { setConnected(false); /* let fetchEventSource retry */ },
    }).catch(() => { /* aborted on unmount */ });
    return () => { ctrl.abort(); setConnected(false); };
  }, [token, driverId]);

  return { dispatch, connected };
}
