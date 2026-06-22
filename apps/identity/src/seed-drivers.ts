import { PrismaClient } from "@flashbite/shared";
import { seedDrivers, hashSeedPassword } from "./seed-shared";

/** Seed only the driver accounts (drv-1..drv-4 @ <tenant>.test) into the DB — the same rows the
 *  full `seed:users` creates alongside the merchant/customer/admin accounts, runnable on its own. */
async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    await seedDrivers(prisma, await hashSeedPassword());
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
