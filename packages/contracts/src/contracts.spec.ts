import {
  AGGREGATE_TYPES,
  ORDER_CANCEL_REASONS,
  CONSUMER_GROUPS,
  CONSUMERS,
  EVENT_TYPES,
  ORDER_STATUS,
  READ_COLLECTIONS,
  ORDER_SAGA,
  ORDER_SAGA_RESULTS,
  TOPICS,
} from "@flashbite/contracts";

describe("contracts constants", () => {
  it("exposes stable event/aggregate/status values", () => {
    expect(AGGREGATE_TYPES.ORDER).toBe("ORDER");
    expect(EVENT_TYPES).toEqual({
      ORDER_PLACED: "OrderPlaced",
      ORDER_ACCEPTED: "OrderAccepted",
      ORDER_CANCELLED: "OrderCancelled",
    });
    expect(ORDER_STATUS).toEqual({ PLACED: "PLACED", ACCEPTED: "ACCEPTED", CANCELLED: "CANCELLED" });
  });

  it("exposes messaging + read-model names", () => {
    expect(TOPICS.ORDER_EVENTS).toBe("order-events");
    expect(TOPICS.TELEMETRY_STREAMS).toBe("telemetry-streams");
    expect(CONSUMER_GROUPS).toEqual({
      PROJECTION: "projection-worker",
      SAGA: "saga-worker",
      READ_API_SSE: "read-api-sse",
    });
    expect(CONSUMERS.PROJECTION).toBe("projection-worker");
    expect(READ_COLLECTIONS).toEqual({ ORDERS: "orders", PROCESSED: "processed_events" });
  });

  it("exposes the saga descriptor consumed by saga-worker + write-api", () => {
    expect(ORDER_SAGA).toEqual({
      TASK_QUEUE: "order-lifecycle",
      WORKFLOW_TYPE: "orderLifecycleWorkflow",
      MERCHANT_APPROVAL_SIGNAL: "merchantApproval",
    });
    expect(ORDER_SAGA_RESULTS).toEqual({
      ACCEPTED: "ACCEPTED",
      CANCELLED_SLA: "CANCELLED_SLA",
      CANCELLED_DECLINED: "CANCELLED_DECLINED",
    });
    expect(ORDER_CANCEL_REASONS).toEqual({ SLA_BREACH: "SLA_BREACH", DECLINED: "DECLINED" });
  });
});
