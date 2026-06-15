"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  listOrders, getOrder, getNearbyDrivers,
  applyOrderEvent, upsertOrder, replaceTenantOrders, statusFromEventType, ORDER_STATUS,
  TENANTS, CITY_CENTERS,
  type OrderView, type OrderStreamEvent, type NearbyDriver, type Tenant,
} from "@flashbite/web-shared";

const DRIVER_POLL_MS = 5000;
const RADIUS_KM = 5;

export interface AdminData {
  orders: OrderView[];
  driversByTenant: Record<string, NearbyDriver[]>;
  errors: string[];
  handleEvent: (tenant: Tenant, e: OrderStreamEvent) => void;
  resync: (tenant: Tenant) => void;
}

export function useAdminData(): AdminData {
  const [orders, setOrders] = useState<OrderView[]>([]);
  const [driversByTenant, setDriversByTenant] = useState<Record<string, NearbyDriver[]>>({});
  const [errors, setErrors] = useState<string[]>([]);
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

  const resync = useCallback((tenant: Tenant) => {
    listOrders(tenant)
      .then((rows) => setOrders((prev) => replaceTenantOrders(prev, tenant, rows)))
      .catch(() => noteError(`orders: ${tenant}`));
  }, [noteError]);

  // initial snapshot fan-out
  useEffect(() => {
    for (const tenant of TENANTS) resync(tenant);
  }, [resync]);

  // driver polling fan-out
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async (): Promise<void> => {
      const results = await Promise.all(
        TENANTS.map((t) =>
          getNearbyDrivers(t, CITY_CENTERS[t].lng, CITY_CENTERS[t].lat, RADIUS_KM)
            .then((d) => [t, d] as const)
            .catch(() => { noteError(`drivers: ${t}`); return [t, null] as const; }),
        ),
      );
      if (!active) return;
      setDriversByTenant((prev) => {
        const next = { ...prev };
        for (const [t, d] of results) if (d) next[t] = d;
        return next;
      });
      timer = setTimeout(() => void tick(), DRIVER_POLL_MS);
    };
    void tick();
    return () => { active = false; clearTimeout(timer); };
  }, [noteError]);

  const handleEvent = useCallback((tenant: Tenant, e: OrderStreamEvent) => {
    if (ordersRef.current.some((r) => r.orderId === e.orderId)) {
      setOrders((rows) => applyOrderEvent(rows, e));
    } else if (statusFromEventType(e.eventType) === ORDER_STATUS.PLACED) {
      let tries = 0;
      const fetchRow = (): void => {
        getOrder(tenant, e.orderId)
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

  return { orders, driversByTenant, errors, handleEvent, resync };
}
