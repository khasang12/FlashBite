"use client";
import { DataTable, StatusPill, deliveryStatusLabel, type ColumnDef, type OrderView, type DispatchMap } from "@flashbite/web-shared";

const euro = (cents: number) => `€${(cents / 100).toFixed(2)}`;
const shortId = (id: string) => `#${id.slice(0, 8)}`;
const itemsSummary = (o: OrderView) => (o.items ?? []).map((i) => `${i.sku} ×${i.qty}`).join(", ");
const when = (iso: string) =>
  new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

function buildColumns(dispatches: DispatchMap): ColumnDef<OrderView>[] {
  return [
    { id: "time", accessorKey: "updatedAt", header: "Time", cell: ({ row }) => <span className="text-muted-foreground">{when(row.original.updatedAt)}</span> },
    { id: "order", accessorKey: "orderId", header: "Order", cell: ({ row }) => <span className="font-semibold">{shortId(row.original.orderId)}</span> },
    { id: "customer", accessorKey: "customerId", header: "Customer" },
    { id: "items", header: "Items", cell: ({ row }) => <span className="text-muted-foreground">{itemsSummary(row.original)}</span> },
    { id: "total", accessorKey: "totalAmount", header: "Total", cell: ({ row }) => <span className="font-semibold">{euro(row.original.totalAmount)}</span> },
    { id: "status", accessorKey: "status", header: "Status", cell: ({ row }) => <StatusPill status={row.original.status} /> },
    {
      id: "delivery", header: "Delivery", cell: ({ row }) => {
        const d = dispatches[row.original.orderId];
        return d ? <span className="text-sm font-semibold">{deliveryStatusLabel(d.status)}</span> : <span className="text-muted-foreground">—</span>;
      },
    },
  ];
}

export function OrdersTable({
  data, globalFilter, dispatches, onRowClick,
}: {
  data: OrderView[];
  globalFilter: string;
  dispatches: DispatchMap;
  onRowClick: (o: OrderView) => void;
}) {
  return (
    <DataTable
      columns={buildColumns(dispatches)}
      data={data}
      initialSorting={[{ id: "time", desc: true }]}
      globalFilter={globalFilter}
      onRowClick={onRowClick}
    />
  );
}
