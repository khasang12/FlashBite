import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusPill } from "./status-pill";

describe("StatusPill", () => {
  it("renders the status label", () => {
    render(<StatusPill status="ACCEPTED" />);
    expect(screen.getByText("ACCEPTED")).toBeInTheDocument();
  });

  it("applies the accepted variant class", () => {
    render(<StatusPill status="ACCEPTED" />);
    expect(screen.getByText("ACCEPTED").className).toContain("status-accepted");
  });

  it("falls back gracefully for unknown status", () => {
    render(<StatusPill status="WEIRD" />);
    expect(screen.getByText("WEIRD")).toBeInTheDocument();
  });
});
