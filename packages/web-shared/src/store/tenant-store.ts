// Tenants are runtime data (the catalog), not a compile-time union. The list/metadata live in the
// DB and are fetched via useTenants(); this is just the type alias the frontends reference.
export type { Tenant } from "@flashbite/contracts";
