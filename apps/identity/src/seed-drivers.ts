import { PrismaClient } from "@flashbite/shared";
import { seedDrivers, tenantSlugs, hashSeedPassword } from "./seed-shared";

/** Seed only the driver accounts (drv-1..drv-4 @ <tenant>.test) into the DB - the same rows the
 *  full `seed:users` creates alongside the merchant/customer/admin accounts, runnable on its own. */
async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const slugs = await tenantSlugs(prisma);
    if (slugs.length === 0) {
      // eslint-disable-next-line no-console
      console.warn("No active tenants found - run `pnpm seed:tenants` first.");
    }
    await seedDrivers(prisma, await hashSeedPassword(), slugs);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
