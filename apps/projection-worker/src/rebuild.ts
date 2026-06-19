import { PrismaClient } from "@flashbite/shared";
import { connectMongo } from "@flashbite/shared";
import { READ_COLLECTIONS, type EventEnvelope } from "@flashbite/contracts";
import { applyEvent } from "./projection";

/**
 * Rebuilds the Mongo read model from the Postgres event store. Clears the orders +
 * processed_events collections (so applyEvent's inbox-dedup re-applies), then replays
 * every event in (tenantId, aggregateId, version) order through the SAME applyEvent the
 * live projection uses. Runs as the privileged DATABASE_URL role (cross-tenant, bypasses RLS).
 */
export async function rebuildProjection(): Promise<{ events: number }> {
  const prisma = new PrismaClient(); // DATABASE_URL (superuser) — reads all tenants
  await prisma.$connect();
  const { client, db } = await connectMongo();
  try {
    await db.collection(READ_COLLECTIONS.ORDERS).deleteMany({});
    await db.collection(READ_COLLECTIONS.PROCESSED).deleteMany({});
    const rows = await prisma.eventStore.findMany({
      orderBy: [{ tenantId: "asc" }, { aggregateId: "asc" }, { version: "asc" }],
    });
    for (const r of rows) {
      const envelope: EventEnvelope = {
        tenantId: r.tenantId,
        eventId: r.id,
        eventType: r.eventType,
        version: r.version,
        occurredAt: r.occurredAt.toISOString(),
        payload: r.payload as unknown,
      };
      await applyEvent(db, envelope);
    }
    return { events: rows.length };
  } finally {
    await client.close();
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  rebuildProjection()
    .then(({ events }) => {
      // eslint-disable-next-line no-console
      console.log(`rebuild:projection — replayed ${events} events`);
      process.exit(0);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(err);
      process.exit(1);
    });
}
