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
  DISPATCH_STATUS,
  DISPATCH_SAGA,
  driverGeoKey,
  tenantKey,
  dispatchAggregateId,
} from "@flashbite/contracts";

describe("contracts constants", () => {
  it("exposes stable event/aggregate/status values", () => {
    expect(AGGREGATE_TYPES.ORDER).toBe("ORDER");
    expect(AGGREGATE_TYPES.DISPATCH).toBe("DISPATCH");
    expect(EVENT_TYPES).toEqual({
      ORDER_PLACED: "OrderPlaced",
      ORDER_ACCEPTED: "OrderAccepted",
      ORDER_CANCELLED: "OrderCancelled",
      DRIVER_TELEMETRY_STREAMED: "DriverTelemetryStreamed",
      DRIVER_OFFERED: "DriverOffered",
      DISPATCH_ACCEPTED: "DispatchAccepted",
      ORDER_PICKED_UP: "OrderPickedUp",
      ORDER_DELIVERED: "OrderDelivered",
      DISPATCH_FAILED: "DispatchFailed",
    });
    expect(ORDER_STATUS).toEqual({ PLACED: "PLACED", ACCEPTED: "ACCEPTED", CANCELLED: "CANCELLED" });
  });

  it("exposes messaging + read-model names", () => {
    expect(TOPICS.ORDER_EVENTS).toBe("order-events");
    expect(TOPICS.TELEMETRY_STREAMS).toBe("telemetry-streams");
    expect(TOPICS.DISPATCH_EVENTS).toBe("dispatch-events");
    expect(CONSUMER_GROUPS).toEqual({
      PROJECTION: "projection-worker",
      SAGA: "saga-worker",
      READ_API_SSE: "read-api-sse",
      TELEMETRY: "telemetry-worker",
      DISPATCH_PROJECTION: "dispatch-projection",
    });
    expect(CONSUMERS.PROJECTION).toBe("projection-worker");
    expect(READ_COLLECTIONS).toEqual({ ORDERS: "orders", PROCESSED: "processed_events", DISPATCHES: "dispatches" });
  });

  it("exposes the saga descriptor consumed by saga-worker + write-api", () => {
    expect(ORDER_SAGA).toEqual({
      TASK_QUEUE: "order-lifecycle",
      WORKFLOW_TYPE: "orderLifecycleWorkflow",
      MERCHANT_APPROVAL_SIGNAL: "merchantApproval",
      CONFIRM_PAYMENT_SIGNAL: "confirmPayment",
    });
    expect(ORDER_SAGA_RESULTS).toEqual({
      ACCEPTED: "ACCEPTED",
      CANCELLED_SLA: "CANCELLED_SLA",
      CANCELLED_DECLINED: "CANCELLED_DECLINED",
      CANCELLED_PAYMENT_FAILED: "CANCELLED_PAYMENT_FAILED",
      CANCELLED_PAYMENT_TIMEOUT: "CANCELLED_PAYMENT_TIMEOUT",
      DELIVERED: "DELIVERED",
      DISPATCH_FAILED: "DISPATCH_FAILED",
    });
    expect(ORDER_CANCEL_REASONS).toEqual({
      SLA_BREACH: "SLA_BREACH",
      DECLINED: "DECLINED",
      PAYMENT_FAILED: "PAYMENT_FAILED",
      PAYMENT_TIMEOUT: "PAYMENT_TIMEOUT",
    });
  });

  it("exposes telemetry constants + geo key helper", () => {
    expect(EVENT_TYPES.DRIVER_TELEMETRY_STREAMED).toBe("DriverTelemetryStreamed");
    expect(CONSUMER_GROUPS.TELEMETRY).toBe("telemetry-worker");
    expect(driverGeoKey("berlin")).toBe("tenant:{berlin}:drivers:geo");
  });

  it("builds tenant-scoped keys with the hash tag around only the id", () => {
    // The {id} hash tag co-locates a tenant's keys; the colon stays outside the
    // braces so key-tree viewers nest cleanly (tenant > {id} > ...).
    expect(tenantKey("berlin")).toBe("tenant:{berlin}");
    expect(tenantKey("tokyo", "order", "o-1", "view")).toBe("tenant:{tokyo}:order:o-1:view");
  });

  it("exposes dispatch constants and helpers", () => {
    expect(DISPATCH_STATUS.OFFERED).toBe("OFFERED");
    expect(DISPATCH_STATUS.DISPATCHED).toBe("DISPATCHED");
    expect(DISPATCH_STATUS.PICKED_UP).toBe("PICKED_UP");
    expect(DISPATCH_STATUS.DELIVERED).toBe("DELIVERED");
    expect(DISPATCH_STATUS.FAILED).toBe("FAILED");
    expect(DISPATCH_SAGA.WORKFLOW_TYPE).toBe("driverDispatchWorkflow");
    expect(DISPATCH_SAGA.TASK_QUEUE).toBe("order-lifecycle");
    expect(dispatchAggregateId("o1")).toBe("dispatch:o1");
  });
});
