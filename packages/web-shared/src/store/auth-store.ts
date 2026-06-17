"use client";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export interface AuthClaims {
  sub: string;
  tenantId: string;
  role: string;
}

interface AuthState {
  token: string | null;
  claims: AuthClaims | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

/** Decode the JWT payload (base64url) for display / role-gating. NOT verification — the API verifies. */
function decodeClaims(token: string): AuthClaims {
  const payload = token.split(".")[1] ?? "";
  const json = JSON.parse(
    Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
  ) as Record<string, unknown>;
  return { sub: String(json.sub ?? ""), tenantId: String(json.tenantId ?? ""), role: String(json.role ?? "") };
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      claims: null,
      login: async (email, password) => {
        const res = await fetch("/api/identity/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        });
        if (!res.ok) throw new Error("Invalid email or password");
        const { accessToken } = (await res.json()) as { accessToken: string };
        set({ token: accessToken, claims: decodeClaims(accessToken) });
      },
      logout: () => set({ token: null, claims: null }),
    }),
    { name: "fb-auth", storage: createJSONStorage(() => localStorage), skipHydration: true },
  ),
);
