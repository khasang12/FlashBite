"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  listOrders, getOrder, useOrderStream, applyOrderEvent, upsertOrder,
  statusFromEventType, useTenantStore, Input, ORDER_STATUS,
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
  type OrderView, type OrderStreamEvent,
} from "@flashbite/web-shared";
import { OrdersTable } from "@/components/orders-table";
import { OrderDetailSheet } from "@/components/order-detail-sheet";

export default function Dashboard() {
  const tenant = useTenantStore((s) => s.tenant);
  const [orders, setOrders] = useState<OrderView[]>([]);
  const ordersRef = useRef(orders);
  useEffect(() => { ordersRef.current = orders; }, [orders]);
  const [filter, setFilter] = useState("");
  const [status, setStatus] = useState<string>("ALL");
  const [selected, setSelected] = useState<OrderView | null>(null);

  const resync = useCallback(() => {
    listOrders(tenant).then(setOrders).catch(() => setOrders([]));
  }, [tenant]);

  useEffect(() => { resync(); }, [resync]);

  const onEvent = useCallback((e: OrderStreamEvent) => {
    if (ordersRef.current.some((r) => r.orderId === e.orderId)) {
      setOrders((rows) => applyOrderEvent(rows, e));
    } else if (statusFromEventType(e.eventType) === ORDER_STATUS.PLACED) {
      // The OrderPlaced SSE event and the read-model projection are driven by the
      // same order-events topic, so the event can beat the Mongo write. Retry
      // getOrder until the projection catches up (bounded) instead of dropping it.
      let tries = 0;
      const fetchRow = (): void => {
        getOrder(tenant, e.orderId)
          .then((o) => {
            if (o) { setOrders((cur) => upsertOrder(cur, o)); return; }
            if (++tries < 10) setTimeout(fetchRow, 500);
          })
          .catch(() => {});
      };
      fetchRow();
    }
  }, [tenant]);

  useOrderStream(tenant, onEvent, resync);

  const current = selected ? orders.find((o) => o.orderId === selected.orderId) ?? selected : null;
  const visible = status === "ALL" ? orders : orders.filter((o) => o.status === status);

  return (
    <div className="min-h-screen bg-background">
      <header className="flex items-center justify-between border-b px-6 py-4">
        <div className="text-lg font-extrabold">flashbite <span className="text-muted-foreground font-semibold">merchant</span></div>
        <div className="flex items-center gap-2 text-sm font-semibold"><span className="h-2 w-2 rounded-full bg-primary" />{tenant}</div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-6">
        <div className="mb-4 flex items-center gap-3">
          <Input placeholder="Search order id / customer" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Search orders" className="max-w-xs" />
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-40" aria-label="Filter by status">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All statuses</SelectItem>
              <SelectItem value={ORDER_STATUS.PLACED}>Placed</SelectItem>
              <SelectItem value={ORDER_STATUS.ACCEPTED}>Accepted</SelectItem>
              <SelectItem value={ORDER_STATUS.CANCELLED}>Cancelled</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <OrdersTable data={visible} globalFilter={filter} onRowClick={setSelected} />
      </main>
      <OrderDetailSheet order={current} tenant={tenant} onClose={() => setSelected(null)} />
    </div>
  );
}
