"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  getAdminOrders, getAdminDrivers, getOrder,
  applyOrderEvent, upsertOrder, statusFromEventType, ORDER_STATUS,
  type OrderView, type OrderStreamEvent, type NearbyDriver,
} from "@flashbite/web-shared";

const DRIVER_POLL_MS = 5000;

/** The operator SSE stream tags each event payload with tenantId. */
interface AdminOrderStreamEvent extends OrderStreamEvent {
  tenantId?: string;
}

export interface AdminData {
  orders: OrderView[];
  driversByTenant: Record<string, NearbyDriver[]>;
  errors: string[];
  handleEvent: (e: AdminOrderStreamEvent) => void;
  resync: () => void;
  loading: boolean;
}

export function useAdminData(): AdminData {
  const [orders, setOrders] = useState<OrderView[]>([]);
  const [driversByTenant, setDriversByTenant] = useState<Record<string, NearbyDriver[]>>({});
  const [errors, setErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const ordersRef = useRef(orders);
  useEffect(() => { ordersRef.current = orders; }, [orders]);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const noteError = useCallback((msg: string) => {
    if (!mountedRef.current) return;
    setErrors((prev) => (prev.includes(msg) ? prev : [...prev, msg]));
  }, []);

  const resync = useCallback(() => {
    getAdminOrders()
      .then((rows) => { if (mountedRef.current) setOrders(rows); })
      .catch(() => noteError("orders: admin"))
      .finally(() => { if (mountedRef.current) setLoading(false); });
  }, [noteError]);

  // initial snapshot — single cross-tenant fetch
  useEffect(() => { resync(); }, [resync]);

  // driver polling — single cross-tenant fetch, grouped by tenantId
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async (): Promise<void> => {
      try {
        const drivers = await getAdminDrivers();
        if (!active) return;
        const grouped: Record<string, NearbyDriver[]> = {};
        for (const d of drivers) {
          const { tenantId, ...driver } = d;
          (grouped[tenantId] ??= []).push(driver);
        }
        setDriversByTenant(grouped);
      } catch {
        if (active) noteError("drivers: admin");
      }
      if (active) timer = setTimeout(() => void tick(), DRIVER_POLL_MS);
    };
    void tick();
    return () => { active = false; clearTimeout(timer); };
  }, [noteError]);

  const handleEvent = useCallback((e: AdminOrderStreamEvent) => {
    if (ordersRef.current.some((r) => r.orderId === e.orderId)) {
      setOrders((rows) => applyOrderEvent(rows, e));
    } else if (statusFromEventType(e.eventType) === ORDER_STATUS.PLACED) {
      let tries = 0;
      const fetchRow = (): void => {
        getOrder(e.orderId)
          .then((o) => {
            if (!mountedRef.current) return;
            if (o) { setOrders((cur) => upsertOrder(cur, o)); return; }
            if (++tries < 10) setTimeout(fetchRow, 500);
          })
          .catch(() => {});
      };
      fetchRow();
    }
  }, []);

  return { orders, driversByTenant, errors, handleEvent, resync, loading };
}
