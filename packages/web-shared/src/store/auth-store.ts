"use client";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

// Identifies this frontend so identity scopes the httpOnly refresh cookie per-app
// (cookies ignore port, so localhost apps would otherwise share one fb_rt). Set per app
// via next.config `env`. Empty -> identity uses the base cookie name (back-compat).
const FB_APP = process.env.NEXT_PUBLIC_FB_APP;
const fbAppHeader = (): Record<string, string> => (FB_APP ? { "X-FB-App": FB_APP } : {});

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
  setToken: (token: string) => void;
}

/** Decode the JWT payload (base64url) for display / role-gating. NOT verification — the API verifies. */
function decodeClaims(token: string): AuthClaims {
  try {
    const payload = token.split(".")[1] ?? "";
    const json = JSON.parse(
      Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    ) as Record<string, unknown>;
    return { sub: String(json.sub ?? ""), tenantId: String(json.tenantId ?? ""), role: String(json.role ?? "") };
  } catch {
    return { sub: "", tenantId: "", role: "" };
  }
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      claims: null,
      login: async (email, password) => {
        const res = await fetch("/api/identity/auth/login", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json", ...fbAppHeader() },
          body: JSON.stringify({ email, password }),
        });
        if (!res.ok) throw new Error("Invalid email or password");
        const { accessToken } = (await res.json()) as { accessToken: string };
        set({ token: accessToken, claims: decodeClaims(accessToken) });
      },
      logout: () => {
        // best-effort server revoke (clears the httpOnly RT cookie); state is cleared regardless.
        void Promise.resolve(fetch("/api/identity/auth/logout", { method: "POST", credentials: "include", headers: fbAppHeader() })).catch(() => undefined);
        set({ token: null, claims: null });
      },
      setToken: (token) => set({ token, claims: decodeClaims(token) }),
    }),
    { name: "fb-auth", storage: createJSONStorage(() => localStorage), skipHydration: true },
  ),
);
