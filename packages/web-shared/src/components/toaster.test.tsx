import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { Toaster } from "./toaster";

describe("Toaster", () => {
  it("mounts the sonner toast host without crashing", () => {
    render(<Toaster />);
    expect(document.querySelector("section[aria-label*='Notifications']")).not.toBeNull();
  });
});
