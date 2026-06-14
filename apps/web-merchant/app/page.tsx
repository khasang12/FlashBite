"use client";
import { useEffect, useState } from "react";
import { listOrders, useTenantStore, Input, type OrderView } from "@flashbite/web-shared";
import { OrdersTable } from "@/components/orders-table";

export default function Dashboard() {
  const tenant = useTenantStore((s) => s.tenant);
  const [orders, setOrders] = useState<OrderView[]>([]);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    let active = true;
    listOrders(tenant).then((rows) => { if (active) setOrders(rows); }).catch(() => { if (active) setOrders([]); });
    return () => { active = false; };
  }, [tenant]);

  return (
    <div className="min-h-screen bg-background">
      <header className="flex items-center justify-between border-b px-6 py-4">
        <div className="text-lg font-extrabold">flashbite <span className="text-muted-foreground font-semibold">merchant</span></div>
        <div className="flex items-center gap-2 text-sm font-semibold"><span className="h-2 w-2 rounded-full bg-primary" />{tenant}</div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-6">
        <div className="mb-4 flex items-center gap-3">
          <Input placeholder="Search order id / customer" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Search orders" className="max-w-xs" />
        </div>
        <OrdersTable data={orders} globalFilter={filter} onRowClick={() => { /* sheet in Task 8 */ }} />
      </main>
    </div>
  );
}
