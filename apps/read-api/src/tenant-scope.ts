import { getTenantId, getAuthContext } from "@flashbite/tenant-context";
import { tenantKey, driverGeoKey } from "@flashbite/contracts";

/**
 * Read-side tenant scoping. read-api isolates tenants in application code (Mongo/Redis
 * have no Postgres-style RLS), so EVERY tenant-scoped read must derive the tenant from
 * the verified JWT and bake it into the id / filter / key. Going through these helpers —
 * rather than hand-building `{ tenantId }` or `${tenantId}:id` at each call site — keeps
 * that impossible to forget. (Cross-tenant operator reads deliberately bypass this.)
 */

/** The current request's tenant id (from the verified JWT via AsyncLocalStorage). */
export const currentTenant = (): string => getTenantId();

/** The current request's authenticated subject (driverId for driver tokens). */
export const currentSub = (): string => getAuthContext().sub;

/** Mongo _id for a tenant-owned aggregate: "<tenant>:<id>". */
export const scopedId = (id: string): string => `${getTenantId()}:${id}`;

/** Mongo filter scoped to the current tenant, merging any extra fields. */
export const tenantFilter = <T extends Record<string, unknown>>(extra?: T): { tenantId: string } & T =>
  ({ tenantId: getTenantId(), ...(extra ?? ({} as T)) });

/** Redis key scoped + hash-tagged to the current tenant. */
export const scopedKey = (...parts: string[]): string => tenantKey(getTenantId(), ...parts);

/** Redis geo key for the current tenant's drivers. */
export const scopedGeoKey = (): string => driverGeoKey(getTenantId());
