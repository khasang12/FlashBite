import { AsyncLocalStorage } from "node:async_hooks";

export class TenantContextError extends Error {}

const storage = new AsyncLocalStorage<{ tenantId: string }>();

export function runWithTenant<T>(tenantId: string, fn: () => T): T {
  return storage.run({ tenantId }, fn);
}

export function getTenantId(): string {
  const store = storage.getStore();
  if (!store) {
    throw new TenantContextError("No tenant context in scope");
  }
  return store.tenantId;
}
