import type { Db } from "mongodb";
import {
  CONSUMER_GROUPS,
  EVENT_TYPES,
  READ_COLLECTIONS,
  DISPATCH_STATUS,
  type EventEnvelope,
  type DriverOfferedPayload,
  type DispatchAcceptedPayload,
  type DispatchFailedPayload,
} from "@flashbite/contracts";

const CONSUMER_NAME = CONSUMER_GROUPS.DISPATCH_PROJECTION;

export async function applyDispatchEvent(db: Db, envelope: EventEnvelope, offerTimeoutSeconds = 30): Promise<"applied" | "skipped"> {
  const inbox = db.collection(READ_COLLECTIONS.PROCESSED);
  const inboxId = `${envelope.tenantId}:${CONSUMER_NAME}:${envelope.eventId}`;

  if (await inbox.findOne({ _id: inboxId as never })) return "skipped";

  const col = db.collection(READ_COLLECTIONS.DISPATCHES);
  const orderId = (envelope.payload as { orderId: string }).orderId;
  const _id = `${envelope.tenantId}:${orderId}`;
  const base = {
    tenantId: envelope.tenantId,
    orderId,
    version: envelope.version,
    updatedAt: envelope.occurredAt,
  };

  let set: Record<string, unknown> | null = null;
  switch (envelope.eventType) {
    case EVENT_TYPES.DRIVER_OFFERED:
      set = {
        ...base,
        status: DISPATCH_STATUS.OFFERED,
        offeredDriverId: (envelope.payload as DriverOfferedPayload).driverId,
        offerExpiresAt: new Date(Date.parse(envelope.occurredAt) + offerTimeoutSeconds * 1000).toISOString(),
      };
      break;
    case EVENT_TYPES.DISPATCH_ACCEPTED:
      set = {
        ...base,
        status: DISPATCH_STATUS.DISPATCHED,
        driverId: (envelope.payload as DispatchAcceptedPayload).driverId,
      };
      break;
    case EVENT_TYPES.ORDER_PICKED_UP:
      set = { ...base, status: DISPATCH_STATUS.PICKED_UP };
      break;
    case EVENT_TYPES.ORDER_DELIVERED:
      set = { ...base, status: DISPATCH_STATUS.DELIVERED };
      break;
    case EVENT_TYPES.DISPATCH_FAILED:
      set = {
        ...base,
        status: DISPATCH_STATUS.FAILED,
        reason: (envelope.payload as DispatchFailedPayload).reason,
      };
      break;
  }

  if (set) {
    const existing = await col.findOne({ _id: _id as never });
    if (!existing || (existing.version as number) < envelope.version) {
      await col.updateOne({ _id: _id as never }, { $set: set }, { upsert: true });
    }
  }

  try {
    await inbox.insertOne({
      _id: inboxId as never,
      tenantId: envelope.tenantId,
      consumer: CONSUMER_NAME,
      eventId: envelope.eventId,
      processedAt: new Date(),
    });
  } catch (err) {
    if ((err as { code?: number }).code !== 11000) throw err;
  }

  return "applied";
}
