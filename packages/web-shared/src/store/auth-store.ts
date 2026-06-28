"use client";
import { create } from "zustand";

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
  /** True until the initial refresh-bootstrap settles; gate UI on it to avoid a login flash. */
  booting: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  setToken: (token: string) => void;
  /** Restore the in-memory session from the httpOnly refresh cookie (runs once per app load). */
  bootstrap: () => Promise<void>;
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

// Run the refresh-bootstrap once per app load (a real page reload re-imports this module and resets it).
// Guarding here — not in the React tree — keeps client-side navigations (which remount AuthGate) from
// re-hitting /auth/refresh and needlessly rotating the refresh token.
let bootstrapped = false;

// The access token lives ONLY in memory (this store) — never localStorage — so XSS can't read it at
// rest. The long-lived credential is the httpOnly refresh cookie; on load we exchange it for a fresh AT.
export const useAuthStore = create<AuthState>((set) => ({
  token: null,
  claims: null,
  booting: true,
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
  bootstrap: async () => {
    if (bootstrapped) return;
    bootstrapped = true;
    try {
      // Funnel through the shared single-flight (below). Critical: another part of the app can fire a
      // refresh on load too (e.g. TenantBranding -> useTenants before the token exists). Sharing ONE
      // /auth/refresh prevents double-spending the one-time-use cookie, which would revoke the family
      // and bounce the user to login. Sets the token on success; a failure/timeout falls through to
      // the login screen (booting is cleared in `finally`).
      await refreshAuthSession();
    } finally {
      set({ booting: false });
    }
  },
}));

/** Cap the refresh round-trip so a hung/unreachable identity can't wedge callers (bootstrap stuck on
 *  "Loading…", authedFetch/SSE pending forever). A timeout is treated as a failed refresh. */
const REFRESH_TIMEOUT_MS = 8000;

/** Single-flight: concurrent refreshers share ONE /auth/refresh. The refresh cookie is one-time-use
 *  — a second *concurrent* use is treated as token reuse and revokes the whole family — so every
 *  refresher (bootstrap, authedFetch, the SSE hooks) MUST funnel through here. */
let refreshing: Promise<boolean> | null = null;

async function doRefresh(): Promise<boolean> {
  try {
    const res = await fetch("/api/identity/auth/refresh", {
      method: "POST",
      credentials: "include",
      headers: fbAppHeader(),
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const { accessToken } = (await res.json()) as { accessToken: string };
    useAuthStore.getState().setToken(accessToken);
    return true;
  } catch {
    return false; // network error or timeout — treat as a failed refresh
  }
}

/** Resolves true when a fresh access token was stored, false otherwise (the caller should then log
 *  out). Never rejects. */
export function refreshAuthSession(): Promise<boolean> {
  if (!refreshing) refreshing = doRefresh().finally(() => { refreshing = null; });
  return refreshing;
}
