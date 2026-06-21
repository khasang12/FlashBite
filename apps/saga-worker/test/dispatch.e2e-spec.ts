import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { connectTemporal, RedisService, TemporalHandle } from "@flashbite/shared";
import { CITY_CENTERS, driverGeoKey, driverOnlineKey, driverBusyKey, dispatchAggregateId } from "@flashbite/contracts";
import { startSagaWorker, SagaWorkerHandle } from "../src/main";
import {
  driverDispatchWorkflow, dispatchAcceptSignal, dispatchPickupSignal, dispatchDeliverSignal,
} from "../src/dispatch-workflow";

describe("driver dispatch (e2e: live Temporal + Postgres + Redis)", () => {
  const prisma = new PrismaClient();
  const redis = new RedisService();
  let temporal: TemporalHandle;
  let saga: SagaWorkerHandle;

  beforeAll(async () => {
    await prisma.$connect();
    temporal = await connectTemporal();
    saga = await startSagaWorker();
  }, 60000);
  afterAll(async () => {
    await saga?.stop();
    await temporal?.connection.close();
    await redis.cluster.quit();
    await prisma.$disconnect();
  });

  it("offered driver accepts -> pickup -> deliver records the full dispatch stream", async () => {
    const driverId = `drv-${randomUUID().slice(0, 8)}`;
    const orderId = randomUUID();
    const c = CITY_CENTERS.berlin;
    await redis.cluster.geoadd(driverGeoKey("berlin"), c.lng, c.lat, driverId);
    await redis.cluster.sadd(driverOnlineKey("berlin"), driverId);

    const handle = await temporal.client.workflow.start(driverDispatchWorkflow, {
      taskQueue: "order-lifecycle",
      workflowId: `dispatch:berlin:${orderId}`,
      args: [{ tenantId: "berlin", orderId, offerTimeoutSeconds: 30, maxOffers: 5 }],
    });
    await new Promise((r) => setTimeout(r, 1500));
    await handle.signal(dispatchAcceptSignal, driverId);
    await handle.signal(dispatchPickupSignal, driverId);
    await handle.signal(dispatchDeliverSignal, driverId);
    const result = await handle.result();
    expect(result).toBe("DELIVERED");

    const events = await prisma.eventStore.findMany({
      where: { tenantId: "berlin", aggregateId: dispatchAggregateId(orderId) }, orderBy: { version: "asc" },
    });
    expect(events.map((e) => e.eventType)).toEqual(["DriverOffered", "DispatchAccepted", "OrderPickedUp", "OrderDelivered"]);
    expect(await redis.cluster.sismember(driverBusyKey("berlin"), driverId)).toBe(0);

    await prisma.outbox.deleteMany({ where: { partitionKey: `berlin:${dispatchAggregateId(orderId)}` } });
    await prisma.eventStore.deleteMany({ where: { aggregateId: dispatchAggregateId(orderId) } });
    await redis.cluster.zrem(driverGeoKey("berlin"), driverId);
    await redis.cluster.srem(driverOnlineKey("berlin"), driverId);
  }, 60000);
});
