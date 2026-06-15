import { AsyncLocalStorage } from "node:async_hooks";

export class AuthContextError extends Error {}

export interface AuthContext {
  tenantId: string;
  role: string;
  sub: string;
}

const storage = new AsyncLocalStorage<AuthContext>();

export function runWithAuth<T>(ctx: AuthContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getAuthContext(): AuthContext {
  const ctx = storage.getStore();
  if (!ctx) {
    throw new AuthContextError("No auth context in scope");
  }
  return ctx;
}

export function getTenantId(): string {
  return getAuthContext().tenantId;
}

export function getRole(): string {
  return getAuthContext().role;
}
