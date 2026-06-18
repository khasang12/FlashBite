import "reflect-metadata";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import {
  loadAggregate, appendWithExpectedVersion, ConcurrencyError,
  foldOrder, INITIAL_ORDER_STATE,
} from "@flashbite/shared";
import { AGGREGATE_TYPES, EVENT_TYPES, ORDER_STATUS } from "@flashbite/contracts";

// Connect as the restricted flashbite_app role (RLS), derived from DATABASE_URL.
const appUrl = (() => {
  const u = new URL(process.env.DATABASE_URL ?? "postgresql://flashbite@localhost:5434/flashbite_write");
  u.username = "flashbite_app";
  u.password = "flashbite_app_local_dev";
  return u.toString();
})();

describe("aggregate store (e2e)", () => {
  const prisma = new PrismaClient({ datasourceUrl: appUrl });
  beforeAll(async () => { await prisma.$connect(); });
  afterAll(async () => { await prisma.$disconnect(); });

  const placeArgs = (orderId: string) => ({
    tenantId: "berlin", aggregateType: AGGREGATE_TYPES.ORDER, aggregateId: orderId,
    expectedVersion: 0, eventType: EVENT_TYPES.ORDER_PLACED,
    payload: { orderId, customerId: "c-1", items: [], totalAmount: 1000 },
  });

  it("appends then rehydrates the aggregate", async () => {
    const orderId = randomUUID();
    await appendWithExpectedVersion(prisma, placeArgs(orderId));
    const { state, version } = await loadAggregate(prisma, { tenantId: "berlin", aggregateId: orderId }, foldOrder, INITIAL_ORDER_STATE);
    expect(version).toBe(1);
    expect(state.status).toBe(ORDER_STATUS.PLACED);

    await appendWithExpectedVersion(prisma, {
      tenantId: "berlin", aggregateType: AGGREGATE_TYPES.ORDER, aggregateId: orderId,
      expectedVersion: 1, eventType: EVENT_TYPES.ORDER_ACCEPTED, payload: { orderId },
    });
    const after = await loadAggregate(prisma, { tenantId: "berlin", aggregateId: orderId }, foldOrder, INITIAL_ORDER_STATE);
    expect(after.version).toBe(2);
    expect(after.state.status).toBe(ORDER_STATUS.ACCEPTED);
  });

  it("rejects a second append at the same expected version with ConcurrencyError", async () => {
    const orderId = randomUUID();
    await appendWithExpectedVersion(prisma, placeArgs(orderId)); // v1
    await expect(appendWithExpectedVersion(prisma, placeArgs(orderId))).rejects.toBeInstanceOf(ConcurrencyError);
  });

  it("empty stream loads as version 0 / initial state", async () => {
    const { state, version } = await loadAggregate(prisma, { tenantId: "berlin", aggregateId: randomUUID() }, foldOrder, INITIAL_ORDER_STATE);
    expect(version).toBe(0);
    expect(state).toEqual(INITIAL_ORDER_STATE);
  });
});
