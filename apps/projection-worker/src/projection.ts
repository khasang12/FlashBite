import type { Db } from "mongodb";
import {
  CONSUMERS,
  EVENT_TYPES,
  ORDER_STATUS,
  READ_COLLECTIONS,
  type EventEnvelope,
  type OrderPlacedPayload,
  type OrderView,
} from "@flashbite/contracts";

export const CONSUMER_NAME = CONSUMERS.PROJECTION;

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

  const orders = db.collection(READ_COLLECTIONS.ORDERS);
  const _id = `${envelope.tenantId}:${(envelope.payload as { orderId: string }).orderId}`;

  if (envelope.eventType === EVENT_TYPES.ORDER_PLACED) {
    const p = envelope.payload as OrderPlacedPayload;
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
  } else if (
    envelope.eventType === EVENT_TYPES.ORDER_ACCEPTED ||
    envelope.eventType === EVENT_TYPES.ORDER_CANCELLED
  ) {
    const isCancel = envelope.eventType === EVENT_TYPES.ORDER_CANCELLED;
    const status = isCancel ? ORDER_STATUS.CANCELLED : ORDER_STATUS.ACCEPTED;
    const existing = await orders.findOne({ _id: _id as never });
    if (existing && (existing.version as number) < envelope.version) {
      const set: Partial<OrderView> = { status, version: envelope.version, updatedAt: envelope.occurredAt };
      const reason = (envelope.payload as { reason?: string }).reason;
      if (isCancel && reason !== undefined) set.cancelReason = reason;
      await orders.updateOne({ _id: _id as never }, { $set: set });
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
