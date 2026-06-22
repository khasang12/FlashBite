import argon2 from "argon2";
import { PrismaClient } from "@flashbite/shared";
import { ROLES } from "@flashbite/contracts";

export const TENANTS = ["berlin", "tokyo"] as const;
export const SEED_ROLES = [ROLES.CUSTOMER, ROLES.MERCHANT, ROLES.ADMIN] as const;
export const DRIVER_IDS = ["drv-1", "drv-2", "drv-3", "drv-4"] as const;

/** argon2id hash of the shared dev seed password (override via SEED_USER_PASSWORD). */
export function hashSeedPassword(): Promise<string> {
  return argon2.hash(process.env.SEED_USER_PASSWORD ?? "devpassword");
}

/** Driver User.id is a global PK: keep clean ids in berlin and tenant-suffix the rest, so the
 *  JWT sub equals the dispatch driverId for the demo (drv-1 in berlin, drv-1-tokyo elsewhere). */
export function driverUserId(tenantId: string, driverId: string): string {
  return tenantId === "berlin" ? driverId : `${driverId}-${tenantId}`;
}

/** Seed the per-tenant driver accounts (drv-1..drv-4 @ <tenant>.test), idempotent.
 *  Shared by the full user seed and the standalone `seed:drivers` script. */
export async function seedDrivers(prisma: PrismaClient, passwordHash: string): Promise<void> {
  for (const tenantId of TENANTS) {
    for (const driverId of DRIVER_IDS) {
      const id = driverUserId(tenantId, driverId);
      const email = `${driverId}@${tenantId}.test`;
      await prisma.user.upsert({
        where: { email },
        update: { tenantId, role: ROLES.DRIVER, passwordHash },
        create: { id, tenantId, role: ROLES.DRIVER, email, passwordHash },
      });
      // eslint-disable-next-line no-console
      console.log(`seeded ${email} (${tenantId}/${ROLES.DRIVER}, id=${id})`);
    }
  }
}
