import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EmptyState } from "./empty-state";

describe("EmptyState", () => {
  it("renders the title", () => {
    render(<EmptyState title="No orders yet" />);
    expect(screen.getByText("No orders yet")).toBeInTheDocument();
  });

  it("renders the description", () => {
    render(<EmptyState title="Empty" description="Add something" />);
    expect(screen.getByText("Add something")).toBeInTheDocument();
  });

  it("renders an action button that fires onClick", () => {
    const onClick = vi.fn();
    render(<EmptyState title="Empty" action={{ label: "Browse", onClick }} />);
    fireEvent.click(screen.getByRole("button", { name: "Browse" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("renders the action as a link when href is given", () => {
    render(<EmptyState title="Empty" action={{ label: "Home", href: "/" }} />);
    expect(screen.getByRole("link", { name: "Home" })).toHaveAttribute("href", "/");
  });
});
