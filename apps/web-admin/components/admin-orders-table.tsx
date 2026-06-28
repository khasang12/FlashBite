"use client";
import { DataTable, StatusPill, cancelReasonLabel, type ColumnDef, type OrderView } from "@flashbite/web-shared";

const euro = (cents: number) => `€${(cents / 100).toFixed(2)}`;
const shortId = (id: string) => `#${id.slice(0, 8)}`;
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const columns: ColumnDef<OrderView>[] = [
  { id: "time", accessorKey: "updatedAt", header: "Time", cell: ({ row }) => <span className="text-muted-foreground">{hhmm(row.original.updatedAt)}</span> },
  { id: "tenant", accessorKey: "tenantId", header: "Tenant", cell: ({ row }) => <span className="font-semibold">{row.original.tenantId}</span> },
  { id: "order", accessorKey: "orderId", header: "Order", cell: ({ row }) => <span className="font-semibold">{shortId(row.original.orderId)}</span> },
  { id: "customer", accessorKey: "customerId", header: "Customer" },
  { id: "total", accessorKey: "totalAmount", header: "Total", cell: ({ row }) => <span className="font-semibold">{euro(row.original.totalAmount)}</span> },
  {
    id: "status", accessorKey: "status", header: "Status",
    cell: ({ row }) => (
      <span className="flex items-center gap-2">
        <StatusPill status={row.original.status} />
        {cancelReasonLabel(row.original.cancelReason) ? (
          <span className="text-xs text-muted-foreground">{cancelReasonLabel(row.original.cancelReason)}</span>
        ) : null}
      </span>
    ),
  },
];

export function AdminOrdersTable({ data, globalFilter, loading }: { data: OrderView[]; globalFilter: string; loading: boolean }) {
  return (
    <DataTable
      columns={columns}
      data={data}
      initialSorting={[{ id: "time", desc: true }]}
      globalFilter={globalFilter}
      loading={loading}
      emptyMessage="No orders yet."
    />
  );
}
