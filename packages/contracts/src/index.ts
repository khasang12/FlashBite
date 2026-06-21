// Pure domain contracts: types + constants only. No node:crypto / runtime I/O,
// so this module is safe to import inside a Temporal workflow bundle.
// (buildEnvelope lives in @flashbite/shared because it uses node:crypto.)

export interface EventEnvelope<T = unknown> {
  tenantId: string;
  eventId: string;
  eventType: string;
  version: number;
  occurredAt: string;
  payload: T;
}

export interface OrderItem {
  sku: string;
  qty: number;
  price: number;
}

export interface OrderPlacedPayload {
  orderId: string;
  customerId: string;
  items: OrderItem[];
  totalAmount: number;
}

export interface OrderAcceptedPayload {
  orderId: string;
}

export interface OrderCancelledPayload {
  orderId: string;
  reason: string;
}

export interface DriverTelemetryPayload {
  driverId: string;
  orderId?: string;
  lng: number;
  lat: number;
}

/** Builds a tenant-scoped Redis key. The `{id}` hash tag co-locates all of a tenant's
 *  keys on one cluster slot; the leading `tenant:` keeps a readable, cleanly-nested
 *  namespace (the brace wraps only the id, so key-tree viewers don't split on it). */
export function tenantKey(tenantId: string, ...parts: string[]): string {
  return [`tenant:{${tenantId}}`, ...parts].join(":");
}

/** Per-tenant Redis geo key for live driver locations (single-key GEO commands). */
export function driverGeoKey(tenantId: string): string {
  return tenantKey(tenantId, "drivers", "geo");
}

export interface OrderView {
  tenantId: string;
  orderId: string;
  customerId: string;
  items: OrderItem[];
  totalAmount: number;
  status: string;
  version: number;
  updatedAt: string;
  cancelReason?: string;
}

// ---- Event sourcing ----
export const AGGREGATE_TYPES = {
  ORDER: "ORDER",
  DISPATCH: "DISPATCH",
} as const;

export const EVENT_TYPES = {
  ORDER_PLACED: "OrderPlaced",
  ORDER_ACCEPTED: "OrderAccepted",
  ORDER_CANCELLED: "OrderCancelled",
  DRIVER_TELEMETRY_STREAMED: "DriverTelemetryStreamed",
  DRIVER_OFFERED: "DriverOffered",
  DISPATCH_ACCEPTED: "DispatchAccepted",
  ORDER_PICKED_UP: "OrderPickedUp",
  ORDER_DELIVERED: "OrderDelivered",
  DISPATCH_FAILED: "DispatchFailed",
} as const;

export const ORDER_STATUS = {
  PLACED: "PLACED",
  ACCEPTED: "ACCEPTED",
  CANCELLED: "CANCELLED",
} as const;

// ---- Messaging ----
export const TOPICS = {
  ORDER_EVENTS: "order-events",
  TELEMETRY_STREAMS: "telemetry-streams",
  DISPATCH_EVENTS: "dispatch-events",
} as const;

/** Kafka consumer group ids — one per consuming service. */
export const CONSUMER_GROUPS = {
  PROJECTION: "projection-worker",
  SAGA: "saga-worker",
  READ_API_SSE: "read-api-sse",
  TELEMETRY: "telemetry-worker",
  DISPATCH_PROJECTION: "dispatch-projection",
} as const;

/** Avro record namespace; the record fullname feeds TopicRecordNameStrategy subjects. */
export const AVRO_NAMESPACE = "com.flashbite.events";

/** One Avro subject per event type. avsc = filename under packages/contracts/avro/. */
export const SUBJECTS = [
  { eventType: EVENT_TYPES.ORDER_PLACED, topic: TOPICS.ORDER_EVENTS, recordName: "OrderPlaced", avsc: "order-placed.avsc" },
  { eventType: EVENT_TYPES.ORDER_ACCEPTED, topic: TOPICS.ORDER_EVENTS, recordName: "OrderAccepted", avsc: "order-accepted.avsc" },
  { eventType: EVENT_TYPES.ORDER_CANCELLED, topic: TOPICS.ORDER_EVENTS, recordName: "OrderCancelled", avsc: "order-cancelled.avsc" },
  { eventType: EVENT_TYPES.DRIVER_TELEMETRY_STREAMED, topic: TOPICS.TELEMETRY_STREAMS, recordName: "DriverTelemetry", avsc: "driver-telemetry.avsc" },
  { eventType: EVENT_TYPES.DRIVER_OFFERED, topic: TOPICS.DISPATCH_EVENTS, recordName: "DriverOffered", avsc: "driver-offered.avsc" },
  { eventType: EVENT_TYPES.DISPATCH_ACCEPTED, topic: TOPICS.DISPATCH_EVENTS, recordName: "DispatchAccepted", avsc: "dispatch-accepted.avsc" },
  { eventType: EVENT_TYPES.ORDER_PICKED_UP, topic: TOPICS.DISPATCH_EVENTS, recordName: "OrderPickedUp", avsc: "order-picked-up.avsc" },
  { eventType: EVENT_TYPES.ORDER_DELIVERED, topic: TOPICS.DISPATCH_EVENTS, recordName: "OrderDelivered", avsc: "order-delivered.avsc" },
  { eventType: EVENT_TYPES.DISPATCH_FAILED, topic: TOPICS.DISPATCH_EVENTS, recordName: "DispatchFailed", avsc: "dispatch-failed.avsc" },
] as const;

/** Subject name = `${topic}-${namespace}.${recordName}` (TopicRecordNameStrategy). */
export function subjectFor(topic: string, recordName: string): string {
  return `${topic}-${AVRO_NAMESPACE}.${recordName}`;
}

// ---- Read models ----
export const READ_COLLECTIONS = {
  ORDERS: "orders",
  PROCESSED: "processed_events",
  DISPATCHES: "dispatches",
} as const;

/** Inbox consumer names (processed_events dedup key segment). */
export const CONSUMERS = {
  PROJECTION: "projection-worker",
} as const;

// ---- Temporal order-lifecycle saga ----
export const ORDER_SAGA = {
  TASK_QUEUE: "order-lifecycle",
  WORKFLOW_TYPE: "orderLifecycleWorkflow",
  MERCHANT_APPROVAL_SIGNAL: "merchantApproval",
  CONFIRM_PAYMENT_SIGNAL: "confirmPayment",
} as const;

/** Terminal results returned by the order-lifecycle workflow. */
export const ORDER_SAGA_RESULTS = {
  ACCEPTED: "ACCEPTED",
  CANCELLED_SLA: "CANCELLED_SLA",
  CANCELLED_DECLINED: "CANCELLED_DECLINED",
  CANCELLED_PAYMENT_FAILED: "CANCELLED_PAYMENT_FAILED",
  CANCELLED_PAYMENT_TIMEOUT: "CANCELLED_PAYMENT_TIMEOUT",
  DELIVERED: "DELIVERED",
  DISPATCH_FAILED: "DISPATCH_FAILED",
} as const;

/** Reason recorded on an OrderCancelled event. */
export const ORDER_CANCEL_REASONS = {
  SLA_BREACH: "SLA_BREACH",
  DECLINED: "DECLINED",
  PAYMENT_FAILED: "PAYMENT_FAILED",
  PAYMENT_TIMEOUT: "PAYMENT_TIMEOUT",
} as const;

// ---- Driver dispatch (Phase 3d) ----
export const DISPATCH_STATUS = {
  OFFERED: "OFFERED",
  DISPATCHED: "DISPATCHED",
  PICKED_UP: "PICKED_UP",
  DELIVERED: "DELIVERED",
  FAILED: "FAILED",
} as const;
export type DispatchStatus = (typeof DISPATCH_STATUS)[keyof typeof DISPATCH_STATUS];

export const DISPATCH_SAGA = {
  TASK_QUEUE: ORDER_SAGA.TASK_QUEUE,
  WORKFLOW_TYPE: "driverDispatchWorkflow",
  ACCEPT_SIGNAL: "dispatchAccept",
  REJECT_SIGNAL: "dispatchReject",
  PICKUP_SIGNAL: "dispatchPickup",
  DELIVER_SIGNAL: "dispatchDeliver",
} as const;

export const DISPATCH_FAIL_REASONS = {
  NO_DRIVERS_AVAILABLE: "NO_DRIVERS_AVAILABLE",
  DELIVERY_TIMEOUT: "DELIVERY_TIMEOUT",
} as const;

export interface DriverOfferedPayload { orderId: string; driverId: string }
export interface DispatchAcceptedPayload { orderId: string; driverId: string }
export interface OrderPickedUpPayload { orderId: string }
export interface OrderDeliveredPayload { orderId: string }
export interface DispatchFailedPayload { orderId: string; reason: string }

export interface DispatchView {
  tenantId: string;
  orderId: string;
  status: DispatchStatus;
  driverId?: string;
  offeredDriverId?: string;
  reason?: string;
  version: number;
  updatedAt: string;
}

export function dispatchAggregateId(orderId: string): string { return `dispatch:${orderId}`; }
export function driverOnlineKey(tenantId: string): string { return tenantKey(tenantId, "drivers", "online"); }
export function driverBusyKey(tenantId: string): string { return tenantKey(tenantId, "drivers", "busy"); }

// ---- Auth ----
export const ROLES = {
  CUSTOMER: "customer",
  MERCHANT: "merchant",
  DRIVER: "driver",
  ADMIN: "admin",
  OPERATOR: "operator",
} as const;
export type Role = (typeof ROLES)[keyof typeof ROLES];

// ---- Geo / operator console ----
export const TENANTS = ["berlin", "tokyo"] as const;
export type Tenant = (typeof TENANTS)[number];

export interface GeoPoint {
  lng: number;
  lat: number;
}

export const CITY_CENTERS: Record<Tenant, GeoPoint> = {
  berlin: { lng: 13.405, lat: 52.52 },
  tokyo: { lng: 139.7, lat: 35.68 },
};

export interface NearbyDriver {
  driverId: string;
  distanceKm: number;
  lng: number;
  lat: number;
}

// ---- Payments (Phase 3c) ----
export const PAYMENT_STATUS = {
  AUTHORIZED: "AUTHORIZED",
  CAPTURED: "CAPTURED",
  VOIDED: "VOIDED",
  DECLINED: "DECLINED",
} as const;
export type PaymentStatus = (typeof PAYMENT_STATUS)[keyof typeof PAYMENT_STATUS];

/** Request bodies the saga sends to the payments service. */
export interface AuthorizePaymentRequest {
  tenantId: string;
  orderId: string;
  amount: number;
  idempotencyKey: string;
}
export interface CaptureVoidRequest {
  tenantId: string;
  orderId: string;
  idempotencyKey: string;
}

/** Response from authorize/capture/void. `outcome` is the lowercase result word. */
export interface PaymentResponse {
  paymentId: string;
  outcome: "authorized" | "declined" | "captured" | "voided";
}

/** Read-side projection of a payment for the order-tracking UI. `status` is null when no payment exists yet. */
export interface OrderPaymentView {
  status: PaymentStatus | null;
}
