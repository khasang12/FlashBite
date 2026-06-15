"use client";
import { Card, CardContent, aggregateGmv, orderCounts, type OrderView, type NearbyDriver } from "@flashbite/web-shared";

const euro = (cents: number) => `€${(cents / 100).toFixed(2)}`;

export function StatCards({
  orders, driversByTenant,
}: {
  orders: OrderView[];
  driversByTenant: Record<string, NearbyDriver[]>;
}) {
  const gmv = aggregateGmv(orders);
  const { total, cancelled, cancelRate } = orderCounts(orders);
  const driverEntries = Object.entries(driversByTenant);
  const activeDrivers = driverEntries.reduce((s, [, d]) => s + d.length, 0);

  const cards = [
    { label: "Total GMV", value: euro(gmv), hint: "excl. cancelled" },
    { label: "Orders", value: String(total), hint: "all statuses" },
    { label: "Cancelled", value: `${cancelled} (${(cancelRate * 100).toFixed(1)}%)`, hint: "SLA / declined" },
    { label: "Active drivers", value: String(activeDrivers), hint: driverEntries.map(([t, d]) => `${t} ${d.length}`).join(" · ") || "—" },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {cards.map((c) => (
        <Card key={c.label}>
          <CardContent className="p-4">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">{c.label}</div>
            <div className="mt-1 text-2xl font-extrabold">{c.value}</div>
            <div className="text-xs text-muted-foreground">{c.hint}</div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
