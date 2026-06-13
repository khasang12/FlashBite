import { randomUUID } from "node:crypto";

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

export const EVENT_TYPES = {
  ORDER_PLACED: "OrderPlaced",
  ORDER_ACCEPTED: "OrderAccepted",
  ORDER_CANCELLED: "OrderCancelled",
} as const;

export const TOPICS = {
  ORDER_EVENTS: "order-events",
} as const;

export function buildEnvelope<T>(args: {
  tenantId: string;
  eventType: string;
  version: number;
  payload: T;
  eventId?: string;
  occurredAt?: string;
}): EventEnvelope<T> {
  return {
    tenantId: args.tenantId,
    eventId: args.eventId ?? randomUUID(),
    eventType: args.eventType,
    version: args.version,
    occurredAt: args.occurredAt ?? new Date().toISOString(),
    payload: args.payload,
  };
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
}

export const ORDER_STATUS = {
  PLACED: "PLACED",
  ACCEPTED: "ACCEPTED",
  CANCELLED: "CANCELLED",
} as const;

export interface OrderAcceptedPayload {
  orderId: string;
}

export interface OrderCancelledPayload {
  orderId: string;
  reason: string;
}

export const READ_COLLECTIONS = {
  ORDERS: "orders",
  PROCESSED: "processed_events",
} as const;
