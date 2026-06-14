"use client";
import { DataTable, StatusPill, type ColumnDef, type OrderView } from "@flashbite/web-shared";

const euro = (cents: number) => `€${(cents / 100).toFixed(2)}`;
const shortId = (id: string) => `#${id.slice(0, 8)}`;
const itemsSummary = (o: OrderView) => (o.items ?? []).map((i) => `${i.sku} ×${i.qty}`).join(", ");
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export const orderColumns: ColumnDef<OrderView>[] = [
  { id: "time", accessorKey: "updatedAt", header: "Time", cell: ({ row }) => <span className="text-muted-foreground">{hhmm(row.original.updatedAt)}</span> },
  { id: "order", accessorKey: "orderId", header: "Order", cell: ({ row }) => <span className="font-semibold">{shortId(row.original.orderId)}</span> },
  { id: "customer", accessorKey: "customerId", header: "Customer" },
  { id: "items", header: "Items", cell: ({ row }) => <span className="text-muted-foreground">{itemsSummary(row.original)}</span> },
  { id: "total", accessorKey: "totalAmount", header: "Total", cell: ({ row }) => <span className="font-semibold">{euro(row.original.totalAmount)}</span> },
  { id: "status", accessorKey: "status", header: "Status", cell: ({ row }) => <StatusPill status={row.original.status} /> },
];

export function OrdersTable({
  data, globalFilter, onRowClick,
}: {
  data: OrderView[];
  globalFilter: string;
  onRowClick: (o: OrderView) => void;
}) {
  return (
    <DataTable
      columns={orderColumns}
      data={data}
      initialSorting={[{ id: "time", desc: true }]}
      globalFilter={globalFilter}
      onRowClick={onRowClick}
    />
  );
}
