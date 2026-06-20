import type { PrismaClient } from "@prisma/client";
import {
  loadAggregate, appendWithExpectedVersion,
  foldOrder, accept, cancel, INITIAL_ORDER_STATE, InvalidTransitionError,
  loadConfig,
} from "@flashbite/shared";
import { AGGREGATE_TYPES, EVENT_TYPES } from "@flashbite/contracts";
import { authorizePayment, capturePayment, voidPayment } from "./payments-client";

/**
 * Activities load the Order aggregate, validate the command, and append at the loaded
 * version. An already-terminal order (the SLA-vs-accept race loser) is a benign no-op;
 * a ConcurrencyError propagates so Temporal retries (reload -> re-evaluate).
 */
export function createActivities(prisma: PrismaClient) {
  return {
    async authorizePaymentActivity(tenantId: string, orderId: string, amount: number): Promise<{ authorized: boolean }> {
      return authorizePayment(loadConfig().paymentsUrl, tenantId, orderId, amount);
    },
    async capturePaymentActivity(tenantId: string, orderId: string): Promise<void> {
      await capturePayment(loadConfig().paymentsUrl, tenantId, orderId);
    },
    async voidPaymentActivity(tenantId: string, orderId: string): Promise<void> {
      await voidPayment(loadConfig().paymentsUrl, tenantId, orderId);
    },
    async recordOrderAcceptedActivity(tenantId: string, orderId: string): Promise<void> {
      const { state, version } = await loadAggregate(prisma, { tenantId, aggregateId: orderId }, foldOrder, INITIAL_ORDER_STATE);
      let payload;
      try {
        payload = accept(state, orderId);
      } catch (e) {
        if (e instanceof InvalidTransitionError) return; // already terminal — benign no-op
        throw e;
      }
      await appendWithExpectedVersion(prisma, {
        tenantId, aggregateType: AGGREGATE_TYPES.ORDER, aggregateId: orderId,
        expectedVersion: version, eventType: EVENT_TYPES.ORDER_ACCEPTED, payload,
      });
    },
    async recordOrderCancelledActivity(tenantId: string, orderId: string, reason: string): Promise<void> {
      const { state, version } = await loadAggregate(prisma, { tenantId, aggregateId: orderId }, foldOrder, INITIAL_ORDER_STATE);
      let payload;
      try {
        payload = cancel(state, orderId, reason);
      } catch (e) {
        if (e instanceof InvalidTransitionError) return; // already terminal — benign no-op
        throw e;
      }
      await appendWithExpectedVersion(prisma, {
        tenantId, aggregateType: AGGREGATE_TYPES.ORDER, aggregateId: orderId,
        expectedVersion: version, eventType: EVENT_TYPES.ORDER_CANCELLED, payload,
      });
    },
  };
}

export type Activities = ReturnType<typeof createActivities>;
