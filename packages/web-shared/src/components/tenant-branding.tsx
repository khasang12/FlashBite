"use client";
import { useEffect } from "react";
import { useAuthStore } from "../store/auth-store";
import { useTenants } from "../tenants/use-tenants";

const DEFAULT_BRAND = "#06c167";

/**
 * Applies the logged-in tenant's brand accent at runtime by overriding the `--primary` and
 * `--ring` custom properties on :root. Because `@theme inline` maps `--color-primary` to
 * `var(--primary)`, this recolors every `bg-primary`/`ring`/accent app-wide. Renders nothing.
 * On logout (no tenant) it removes the overrides so the default brand shows.
 */
export function TenantBranding(): null {
  const tenantId = useAuthStore((s) => s.claims?.tenantId);
  const { tenants } = useTenants();

  useEffect(() => {
    const root = document.documentElement;
    if (!tenantId) {
      root.style.removeProperty("--primary");
      root.style.removeProperty("--ring");
      return;
    }
    const color = tenants.find((t) => t.slug === tenantId)?.brandColor ?? DEFAULT_BRAND;
    root.style.setProperty("--primary", color);
    root.style.setProperty("--ring", color);
    return () => {
      root.style.removeProperty("--primary");
      root.style.removeProperty("--ring");
    };
  }, [tenantId, tenants]);

  return null;
}
