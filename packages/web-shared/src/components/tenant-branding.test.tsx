import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { useAuthStore } from "../store/auth-store";
import { TenantBranding } from "./tenant-branding";

vi.mock("../tenants/use-tenants", () => ({
  useTenants: () => ({
    tenants: [
      { slug: "berlin", displayName: "Berlin", lng: 0, lat: 0, status: "active", brandColor: "#06c167" },
      { slug: "tokyo", displayName: "Tokyo", lng: 0, lat: 0, status: "active", brandColor: "#7c3aed" },
      { slug: "nocolor", displayName: "NoColor", lng: 0, lat: 0, status: "active" },
    ],
    loading: false,
  }),
}));

const root = document.documentElement;
afterEach(() => {
  cleanup();
  root.style.removeProperty("--primary");
  root.style.removeProperty("--ring");
});

describe("TenantBranding", () => {
  it("sets --primary/--ring to the logged-in tenant's brandColor", () => {
    useAuthStore.setState({ claims: { sub: "u", tenantId: "tokyo", role: "driver" } });
    render(<TenantBranding />);
    expect(root.style.getPropertyValue("--primary")).toBe("#7c3aed");
    expect(root.style.getPropertyValue("--ring")).toBe("#7c3aed");
  });

  it("falls back to the default brand when the tenant has no brandColor", () => {
    useAuthStore.setState({ claims: { sub: "u", tenantId: "nocolor", role: "driver" } });
    render(<TenantBranding />);
    expect(root.style.getPropertyValue("--primary")).toBe("#06c167");
  });

  it("removes the override when no tenant is logged in", () => {
    useAuthStore.setState({ claims: null });
    render(<TenantBranding />);
    expect(root.style.getPropertyValue("--primary")).toBe("");
  });
});
