import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ErrorState } from "./error-state";

describe("ErrorState", () => {
  it("renders the default title when none is given", () => {
    render(<ErrorState />);
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
  });

  it("renders the description", () => {
    render(<ErrorState description="Boom happened" />);
    expect(screen.getByText("Boom happened")).toBeInTheDocument();
  });

  it("renders an action button that fires onClick", () => {
    const onClick = vi.fn();
    render(<ErrorState action={{ label: "Try again", onClick }} />);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("renders the action as a link when href is given", () => {
    render(<ErrorState action={{ label: "Home", href: "/" }} />);
    expect(screen.getByRole("link", { name: "Home" })).toHaveAttribute("href", "/");
  });

  it("renders the banner variant as an alert with the destructive style", () => {
    render(<ErrorState variant="banner" title="Couldn't load" description="x, y" />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load");
    expect(alert.className).toContain("text-destructive");
  });

  it("renders a secondary action alongside the primary and fires only its own handler", () => {
    const onPrimary = vi.fn();
    const onSecondary = vi.fn();
    render(
      <ErrorState
        action={{ label: "Try again", onClick: onPrimary }}
        secondaryAction={{ label: "Sign out", onClick: onSecondary }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(onSecondary).toHaveBeenCalledTimes(1);
    expect(onPrimary).not.toHaveBeenCalled();
  });
});
