import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable } from "./data-table";

interface Row { id: string; name: string }
const columns: ColumnDef<Row>[] = [
  { id: "id", accessorKey: "id", header: "ID", cell: ({ row }) => <span>{row.original.id}</span> },
  { id: "name", accessorKey: "name", header: "Name", cell: ({ row }) => <span>{row.original.name}</span> },
];

describe("DataTable", () => {
  it("renders 5 skeleton rows while loading (no empty message, no data)", () => {
    const { container } = render(<DataTable columns={columns} data={[]} loading emptyMessage="Nothing here" />);
    expect(screen.queryByText("Nothing here")).toBeNull();
    // 5 rows x 2 columns = 10 skeleton placeholders
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBe(10);
  });

  it("renders the EmptyState when settled and empty", () => {
    const { container } = render(<DataTable columns={columns} data={[]} emptyMessage="Nothing here" />);
    expect(screen.getByText("Nothing here")).toBeInTheDocument();
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBe(0);
  });

  it("renders rows when there is data", () => {
    render(<DataTable columns={columns} data={[{ id: "r1", name: "Alice" }]} emptyMessage="Nothing here" />);
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.queryByText("Nothing here")).toBeNull();
  });
});
