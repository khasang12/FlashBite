"use client";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, AreaChart, Area, CartesianGrid,
} from "recharts";
import type { ValueType } from "recharts/types/component/DefaultTooltipContent";
import {
  gmvByTenant, statusBreakdown, topSkus, gmvOverTime, type OrderView,
} from "@flashbite/web-shared";

const GREEN = "#06C167";
const LIGHT = "#D1FAE5";
const RED = "#FCA5A5";
const euro = (cents: number) => `€${(cents / 100).toFixed(2)}`;
const euroAxis = (cents: number) => `€${(cents / 100).toFixed(0)}`;
const fmtEuro = (v: ValueType | undefined) => typeof v === "number" ? euro(v) : String(v ?? "");

function ChartCard({ title, children }: { title: string; children: React.ReactElement }) {
  return (
    <div className="rounded-xl border p-4">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</div>
      <div style={{ width: "100%", height: 200 }}>
        <ResponsiveContainer>{children}</ResponsiveContainer>
      </div>
    </div>
  );
}

export function GmvByTenantChart({ orders }: { orders: OrderView[] }) {
  return (
    <ChartCard title="GMV by tenant">
      <BarChart data={gmvByTenant(orders)}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="tenant" /><YAxis tickFormatter={(v: number) => euroAxis(v)} width={48} />
        <Tooltip formatter={fmtEuro} />
        <Bar dataKey="gmv" fill={GREEN} radius={[4, 4, 0, 0]} />
      </BarChart>
    </ChartCard>
  );
}

export function StatusBreakdownChart({ orders }: { orders: OrderView[] }) {
  return (
    <ChartCard title="Order status breakdown">
      <BarChart data={statusBreakdown(orders)}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="tenant" /><YAxis allowDecimals={false} width={32} />
        <Tooltip />
        <Legend />
        <Bar dataKey="placed" stackId="s" fill={LIGHT} />
        <Bar dataKey="accepted" stackId="s" fill={GREEN} />
        <Bar dataKey="cancelled" stackId="s" fill={RED} radius={[4, 4, 0, 0]} />
      </BarChart>
    </ChartCard>
  );
}

export function TopSkusChart({ orders }: { orders: OrderView[] }) {
  return (
    <ChartCard title="Top SKUs">
      <BarChart data={topSkus(orders, 5)} layout="vertical">
        <XAxis type="number" allowDecimals={false} hide />
        <YAxis type="category" dataKey="sku" width={64} />
        <Tooltip />
        <Bar dataKey="qty" fill={GREEN} radius={[0, 4, 4, 0]} />
      </BarChart>
    </ChartCard>
  );
}

export function GmvOverTimeChart({ orders }: { orders: OrderView[] }) {
  return (
    <ChartCard title="GMV over time (hourly)">
      <AreaChart data={gmvOverTime(orders)}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="bucket" tickFormatter={(b: string) => b.slice(11)} />
        <YAxis tickFormatter={(v: number) => euroAxis(v)} width={48} />
        <Tooltip formatter={fmtEuro} />
        <Area type="monotone" dataKey="gmv" stroke={GREEN} fill={GREEN} fillOpacity={0.15} />
      </AreaChart>
    </ChartCard>
  );
}
