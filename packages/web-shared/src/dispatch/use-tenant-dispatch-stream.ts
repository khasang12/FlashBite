"use client";
import { useEffect, useState } from "react";
import { fetchEventSource } from "@microsoft/fetch-event-source";
import type { DispatchView } from "@flashbite/contracts";
import { useAuthStore } from "../store/auth-store";
import { getMerchantDispatches } from "../api/client";
import { parseDispatchData, reduceDispatch } from "./use-dispatch-stream";

export type DispatchMap = Record<string, DispatchView>;

/** Merge an incoming dispatch view into the per-order map (version-reconciled). Exported for tests. */
export function reduceDispatchMap(prev: DispatchMap, next: DispatchView): DispatchMap {
  return { ...prev, [next.orderId]: reduceDispatch(prev[next.orderId] ?? null, next) };
}

/**
 * Subscribes to the tenant-wide merchant dispatch SSE stream (every order's delivery state for the
 * merchant's tenant). Fetch-based SSE so the Authorization header is sent. Returns a map of
 * orderId -> latest DispatchView and the connection state.
 */
export function useTenantDispatchStream(): { dispatches: DispatchMap; connected: boolean } {
  const [dispatches, setDispatches] = useState<DispatchMap>({});
  const [connected, setConnected] = useState(false);
  const token = useAuthStore((s) => s.token);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    // Seed every order's current delivery state on load — the SSE only carries *live* updates, so
    // without this the column is empty for existing orders until the next dispatch event. Live
    // events merge on top (version-reconciled), so a newer streamed update is never clobbered.
    void getMerchantDispatches()
      .then((list) => { if (!cancelled) setDispatches((prev) => list.reduce(reduceDispatchMap, prev)); })
      .catch(() => undefined);
    const ctrl = new AbortController();
    void fetchEventSource("/api/read/merchant/dispatch/stream", {
      headers: { Authorization: `Bearer ${token}` },
      signal: ctrl.signal,
      openWhenHidden: true,
      onopen: async (response: Response) => {
        if (response.status === 401) {
          setConnected(false);
          useAuthStore.getState().logout();
          throw new Error("unauthorized");
        }
        setConnected(true);
      },
      onmessage: (msg) => {
        const view = parseDispatchData(msg.data);
        if (view) setDispatches((prev) => reduceDispatchMap(prev, view));
      },
      onerror: () => { setConnected(false); /* let fetchEventSource retry */ },
    }).catch(() => { /* aborted on unmount */ });
    return () => { cancelled = true; ctrl.abort(); setConnected(false); };
  }, [token]);

  return { dispatches, connected };
}
