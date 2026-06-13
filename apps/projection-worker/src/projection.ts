import type { Db } from "mongodb";
import {
  EVENT_TYPES,
  ORDER_STATUS,
  READ_COLLECTIONS,
  type EventEnvelope,
  type OrderPlacedPayload,
} from "@flashbite/contracts";

export const CONSUMER_NAME = "projection-worker";

/**
 * Applies one event envelope to the read model. Inbox-dedup (Mongo) + idempotent
 * upsert with a version guard. At-least-once safe: re-delivery is skipped via the
 * inbox; a crash between upsert and inbox-write re-applies idempotently on replay.
 */
export async function applyEvent(db: Db, envelope: EventEnvelope): Promise<"applied" | "skipped"> {
  const inbox = db.collection(READ_COLLECTIONS.PROCESSED);
  const inboxId = `${envelope.tenantId}:${CONSUMER_NAME}:${envelope.eventId}`;

  if (await inbox.findOne({ _id: inboxId as never })) {
    return "skipped";
  }

  if (envelope.eventType === EVENT_TYPES.ORDER_PLACED) {
    const p = envelope.payload as OrderPlacedPayload;
    const _id = `${envelope.tenantId}:${p.orderId}`;
    const orders = db.collection(READ_COLLECTIONS.ORDERS);
    const existing = await orders.findOne({ _id: _id as never });
    if (!existing || (existing.version as number) < envelope.version) {
      await orders.updateOne(
        { _id: _id as never },
        {
          $set: {
            tenantId: envelope.tenantId,
            orderId: p.orderId,
            customerId: p.customerId,
            items: p.items,
            totalAmount: p.totalAmount,
            status: ORDER_STATUS.PLACED,
            version: envelope.version,
            updatedAt: envelope.occurredAt,
          },
        },
        { upsert: true },
      );
    }
  }
  // Unknown event types fall through and are still marked processed (forward-compatible).

  try {
    await inbox.insertOne({
      _id: inboxId as never,
      tenantId: envelope.tenantId,
      consumer: CONSUMER_NAME,
      eventId: envelope.eventId,
      processedAt: new Date(),
    });
  } catch (err) {
    if ((err as { code?: number }).code !== 11000) throw err; // ignore duplicate-key
  }

  return "applied";
}
