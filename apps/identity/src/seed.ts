import argon2 from "argon2";
import { PrismaClient } from "@flashbite/shared";

const TENANTS = ["berlin", "tokyo"] as const;
const ROLES = ["customer", "merchant", "driver", "admin"] as const;

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const password = process.env.SEED_USER_PASSWORD ?? "devpassword";
  const passwordHash = await argon2.hash(password);
  try {
    for (const tenantId of TENANTS) {
      for (const role of ROLES) {
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
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
