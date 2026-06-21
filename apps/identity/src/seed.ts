import argon2 from "argon2";
import { PrismaClient } from "@flashbite/shared";
import { ROLES } from "@flashbite/contracts";

const TENANTS = ["berlin", "tokyo"] as const;
const SEED_ROLES = [ROLES.CUSTOMER, ROLES.MERCHANT, ROLES.ADMIN] as const;
const DRIVER_IDS = ["drv-1", "drv-2", "drv-3", "drv-4"] as const;

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const password = process.env.SEED_USER_PASSWORD ?? "devpassword";
  const passwordHash = await argon2.hash(password);
  try {
    for (const tenantId of TENANTS) {
      for (const role of SEED_ROLES) {
        const email = `${role}@${tenantId}.test`;
        await prisma.user.upsert({
          where: { email },
          update: { tenantId, role, passwordHash },
          create: { tenantId, role, email, passwordHash },
        });
        // eslint-disable-next-line no-console
        console.log(`seeded ${email} (${tenantId}/${role})`);
      }
      // Drivers get stable ids so the JWT sub IS the dispatch driverId. User.id is a
      // global PK, so keep clean ids in berlin and tenant-suffix the rest.
      for (const driverId of DRIVER_IDS) {
        const id = tenantId === "berlin" ? driverId : `${driverId}-${tenantId}`;
        const email = `${driverId}@${tenantId}.test`;
        await prisma.user.upsert({
          where: { email },
          update: { id, tenantId, role: ROLES.DRIVER, passwordHash },
          create: { id, tenantId, role: ROLES.DRIVER, email, passwordHash },
        });
        // eslint-disable-next-line no-console
        console.log(`seeded ${email} (${tenantId}/${ROLES.DRIVER}, id=${id})`);
      }
    }
    // Platform operator: cross-tenant console principal (not pinned to a tenant).
    await prisma.user.upsert({
      where: { email: "operator@flashbite.test" },
      update: { tenantId: "platform", role: ROLES.OPERATOR, passwordHash },
      create: { tenantId: "platform", role: ROLES.OPERATOR, email: "operator@flashbite.test", passwordHash },
    });
    // eslint-disable-next-line no-console
    console.log("seeded operator@flashbite.test (platform/operator)");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
