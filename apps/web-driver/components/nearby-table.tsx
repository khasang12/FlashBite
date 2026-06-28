"use client";
import { DataTable, formatKm, type ColumnDef, type NearbyDriver } from "@flashbite/web-shared";

const columns: ColumnDef<NearbyDriver>[] = [
  {
    id: "driver",
    accessorKey: "driverId",
    header: "Driver",
    cell: ({ row }) => <span className="font-semibold">{row.original.driverId}</span>,
  },
  {
    id: "distance",
    accessorKey: "distanceKm",
    header: "Distance",
    cell: ({ row }) => <span className="text-muted-foreground">{formatKm(row.original.distanceKm)}</span>,
  },
];

export function NearbyTable({ data, loading }: { data: NearbyDriver[]; loading: boolean }) {
  return (
    <DataTable
      columns={columns}
      data={data}
      initialSorting={[{ id: "distance", desc: false }]}
      loading={loading}
      emptyMessage="No nearby drivers."
    />
  );
}
