"use client";
import { useState } from "react";
import { TENANTS, CITY_CENTERS, Input, type Tenant } from "@flashbite/web-shared";
import { useAdminData } from "@/hooks/use-admin-data";
import { TenantStream } from "@/components/tenant-stream";
import { StatCards } from "@/components/stat-cards";
import { GmvByTenantChart, StatusBreakdownChart, TopSkusChart, GmvOverTimeChart } from "@/components/charts";
import { TenantMap } from "@/components/tenant-map";
import { AdminOrdersTable } from "@/components/admin-orders-table";

export default function AdminPage() {
  const { orders, driversByTenant, errors, handleEvent, resync } = useAdminData();
  const [filter, setFilter] = useState("");

  return (
    <div className="min-h-screen bg-background">
      {TENANTS.map((t: Tenant) => (
        <TenantStream key={t} tenant={t} onEvent={(e) => handleEvent(t, e)} onResync={() => resync(t)} />
      ))}

      <header className="flex items-center justify-between border-b px-6 py-4">
        <div className="text-lg font-extrabold">flashbite <span className="text-muted-foreground font-semibold">admin</span></div>
        <div className="flex items-center gap-2 text-sm font-semibold">
          <span className="h-2 w-2 rounded-full bg-primary" /> live · {TENANTS.join(" + ")}
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-6">
        {errors.length > 0 && (
          <div role="alert" className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-2 text-sm text-destructive">
            Couldn&apos;t load: {errors.join(", ")}
          </div>
        )}

        <StatCards orders={orders} driversByTenant={driversByTenant} />

        <section aria-label="Analytics charts" className="mt-6 grid gap-4 md:grid-cols-2">
          <GmvByTenantChart orders={orders} />
          <StatusBreakdownChart orders={orders} />
          <TopSkusChart orders={orders} />
          <GmvOverTimeChart orders={orders} />
        </section>

        <section aria-label="Driver maps" className="mt-6 grid gap-4 md:grid-cols-2">
          {TENANTS.map((t: Tenant) => (
            <TenantMap key={t} tenant={t} center={CITY_CENTERS[t]} drivers={driversByTenant[t] ?? []} />
          ))}
        </section>

        <section className="mt-6">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Recent orders ({orders.length})
            </div>
            <Input placeholder="Search tenant / order / customer" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Search orders" className="max-w-xs" />
          </div>
          <AdminOrdersTable data={orders} globalFilter={filter} />
        </section>
      </main>
    </div>
  );
}
