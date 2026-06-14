"use client";
import { create } from "zustand";
import { persist, createJSONStorage, type StateStorage } from "zustand/middleware";

export const TENANTS = ["berlin", "tokyo"] as const;
export type Tenant = (typeof TENANTS)[number];

// Persist to a cookie so the value is also readable by the proxy/SSR layer later.
const cookieStorage: StateStorage = {
  getItem: (name) => {
    if (typeof document === "undefined") return null;
    const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
    return m ? decodeURIComponent(m[1]) : null;
  },
  setItem: (name, value) => {
    if (typeof document === "undefined") return;
    document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=31536000; samesite=lax`;
  },
  removeItem: (name) => {
    if (typeof document === "undefined") return;
    document.cookie = `${name}=; path=/; max-age=0`;
  },
};

interface TenantState {
  tenant: Tenant;
  setTenant: (t: Tenant) => void;
}

export const useTenantStore = create<TenantState>()(
  persist(
    (set) => ({ tenant: "berlin", setTenant: (tenant) => set({ tenant }) }),
    { name: "fb-tenant", storage: createJSONStorage(() => cookieStorage), skipHydration: true },
  ),
);
