import type { PrismaClient } from "@prisma/client";
import { appendEvent } from "@flashbite/shared";
import { EVENT_TYPES } from "@flashbite/contracts";

/**
 * Activities are created with a Prisma client so they can append events. The
 * record-* activities own the event-type strings, keeping the workflow free of
 * any contracts import (workflow-bundle determinism).
 */
export function createActivities(prisma: PrismaClient) {
  return {
    async chargePaymentActivity(tenantId: string, orderId: string, amount: number): Promise<void> {
      // Fake payment gateway. Phase 3 swaps in a real provider.
      // eslint-disable-next-line no-console
      console.log(`[charge] tenant=${tenantId} order=${orderId} amount=${amount}`);
    },
    async refundPaymentActivity(tenantId: string, orderId: string, amount: number): Promise<void> {
      // eslint-disable-next-line no-console
      console.log(`[refund] tenant=${tenantId} order=${orderId} amount=${amount}`);
    },
    async recordOrderAcceptedActivity(tenantId: string, orderId: string): Promise<void> {
      await appendEvent(prisma, {
        tenantId, aggregateType: "ORDER", aggregateId: orderId,
        eventType: EVENT_TYPES.ORDER_ACCEPTED, payload: { orderId },
      });
    },
    async recordOrderCancelledActivity(tenantId: string, orderId: string, reason: string): Promise<void> {
      await appendEvent(prisma, {
        tenantId, aggregateType: "ORDER", aggregateId: orderId,
        eventType: EVENT_TYPES.ORDER_CANCELLED, payload: { orderId, reason },
      });
    },
  };
}

export type Activities = ReturnType<typeof createActivities>;
