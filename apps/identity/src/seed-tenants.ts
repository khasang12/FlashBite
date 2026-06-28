import { PrismaClient } from "@flashbite/shared";

const SEED_TENANTS = [
  { slug: "berlin", displayName: "Berlin", lng: 13.405, lat: 52.52, brandColor: "#06c167" },
  { slug: "tokyo", displayName: "Tokyo", lng: 139.7, lat: 35.68, brandColor: "#7c3aed" },
];

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    for (const t of SEED_TENANTS) {
      await prisma.tenant.upsert({
        where: { slug: t.slug },
        update: { displayName: t.displayName, lng: t.lng, lat: t.lat, status: "active", brandColor: t.brandColor },
        create: { ...t, status: "active" },
      });
      // eslint-disable-next-line no-console
      console.log(`seeded tenant ${t.slug} (${t.displayName})`);
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
