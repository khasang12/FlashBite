import type { PrismaClient } from "@prisma/client";
import type { Cluster } from "ioredis";
import {
  loadAggregate, appendWithExpectedVersion,
  foldDispatch, offer, acceptOffer, pickup, deliver, fail, INITIAL_DISPATCH_STATE, InvalidTransitionError,
  TenantCatalogService,
  type DispatchState,
} from "@flashbite/shared";
import {
  AGGREGATE_TYPES, EVENT_TYPES, TOPICS,
  dispatchAggregateId, driverGeoKey, driverOnlineKey, driverBusyKey,
} from "@flashbite/contracts";

/** Dispatch activities — Redis-backed selection/busy + event-sourced appends to the dispatch stream. */
export function createDispatchActivities(prisma: PrismaClient, redis: Cluster) {
  const catalog = new TenantCatalogService(prisma);

  async function append(
    tenantId: string,
    orderId: string,
    eventType: string,
    build: (s: DispatchState) => unknown,
  ): Promise<void> {
    const aggregateId = dispatchAggregateId(orderId);
    const { state, version } = await loadAggregate(prisma, { tenantId, aggregateId }, foldDispatch, INITIAL_DISPATCH_STATE);
    let payload: unknown;
    try {
      payload = build(state);
    } catch (e) {
      if (e instanceof InvalidTransitionError) return; // benign no-op on re-delivery / stale signal
      throw e;
    }
    await appendWithExpectedVersion(prisma, {
      tenantId, aggregateType: AGGREGATE_TYPES.DISPATCH, aggregateId,
      expectedVersion: version, eventType, payload, topic: TOPICS.DISPATCH_EVENTS,
    });
  }

  return {
    async selectNearestAvailableDriverActivity(tenantId: string, exclude: string[]): Promise<string | null> {
      const center = await catalog.get(tenantId);
      if (!center) return null; // unknown tenant -> no driver to offer
      const rows = (await redis.geosearch(
        driverGeoKey(tenantId), "FROMLONLAT", String(center.lng), String(center.lat),
        "BYRADIUS", "50", "km", "ASC",
      )) as string[];
      const ex = new Set(exclude);
      for (const driverId of rows) {
        if (ex.has(driverId)) continue;
        if (!(await redis.sismember(driverOnlineKey(tenantId), driverId))) continue;
        if (await redis.sismember(driverBusyKey(tenantId), driverId)) continue;
        return driverId;
      }
      return null;
    },
    async markBusyActivity(tenantId: string, driverId: string): Promise<void> {
      await redis.sadd(driverBusyKey(tenantId), driverId);
    },
    async clearBusyActivity(tenantId: string, driverId: string): Promise<void> {
      await redis.srem(driverBusyKey(tenantId), driverId);
    },
    async recordDriverOfferedActivity(tenantId: string, orderId: string, driverId: string): Promise<void> {
      await append(tenantId, orderId, EVENT_TYPES.DRIVER_OFFERED, (s) => offer(s, orderId, driverId));
    },
    async recordDispatchAcceptedActivity(tenantId: string, orderId: string, driverId: string): Promise<void> {
      await append(tenantId, orderId, EVENT_TYPES.DISPATCH_ACCEPTED, (s) => acceptOffer(s, orderId, driverId));
    },
    async recordOrderPickedUpActivity(tenantId: string, orderId: string): Promise<void> {
      await append(tenantId, orderId, EVENT_TYPES.ORDER_PICKED_UP, (s) => pickup(s, orderId));
    },
    async recordOrderDeliveredActivity(tenantId: string, orderId: string): Promise<void> {
      await append(tenantId, orderId, EVENT_TYPES.ORDER_DELIVERED, (s) => deliver(s, orderId));
    },
    async recordDispatchFailedActivity(tenantId: string, orderId: string, reason: string): Promise<void> {
      await append(tenantId, orderId, EVENT_TYPES.DISPATCH_FAILED, (s) => fail(s, orderId, reason));
    },
  };
}

export type DispatchActivities = ReturnType<typeof createDispatchActivities>;
