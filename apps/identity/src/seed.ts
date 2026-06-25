import { PrismaClient } from "@flashbite/shared";
import { ROLES } from "@flashbite/contracts";
import { tenantSlugs, SEED_ROLES, seedDrivers, hashSeedPassword } from "./seed-shared";

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const passwordHash = await hashSeedPassword();
  try {
    const slugs = await tenantSlugs(prisma);
    if (slugs.length === 0) {
      // eslint-disable-next-line no-console
      console.warn("No active tenants found - run `pnpm seed:tenants` first.");
    }
    for (const tenantId of slugs) {
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
    }
    // Drivers (drv-1..drv-4) are DB user accounts alongside the merchant/customer/admin rows above.
    await seedDrivers(prisma, passwordHash, slugs);
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
