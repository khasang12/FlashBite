import {
  EVENT_TYPES,
  ORDER_STATUS,
  type OrderItem,
  type OrderPlacedPayload,
  type OrderAcceptedPayload,
  type OrderCancelledPayload,
} from "@flashbite/contracts";

export type OrderStatus = (typeof ORDER_STATUS)[keyof typeof ORDER_STATUS];

export interface OrderState {
  status: OrderStatus | null; // null = does not exist yet
  customerId?: string;
  items?: OrderItem[];
  totalAmount?: number;
  cancelReason?: string;
}

export const INITIAL_ORDER_STATE: OrderState = { status: null };

export class InvalidTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTransitionError";
  }
}

export function foldOrder(state: OrderState, event: { eventType: string; payload: unknown }): OrderState {
  switch (event.eventType) {
    case EVENT_TYPES.ORDER_PLACED: {
      const p = event.payload as OrderPlacedPayload;
      return { status: ORDER_STATUS.PLACED, customerId: p.customerId, items: p.items, totalAmount: p.totalAmount };
    }
    case EVENT_TYPES.ORDER_ACCEPTED:
      return { ...state, status: ORDER_STATUS.ACCEPTED };
    case EVENT_TYPES.ORDER_CANCELLED:
      return { ...state, status: ORDER_STATUS.CANCELLED, cancelReason: (event.payload as OrderCancelledPayload).reason };
    default:
      return state;
  }
}

/** place: returns the event payload, or null when the order already exists (idempotent). */
export function place(state: OrderState, cmd: OrderPlacedPayload): OrderPlacedPayload | null {
  if (state.status !== null) return null;
  return cmd;
}

/** accept: throws InvalidTransitionError unless the order is PLACED. */
export function accept(state: OrderState, orderId: string): OrderAcceptedPayload {
  if (state.status !== ORDER_STATUS.PLACED) {
    throw new InvalidTransitionError(`cannot accept order in status ${String(state.status)}`);
  }
  return { orderId };
}

/** cancel: throws InvalidTransitionError unless the order is PLACED. */
export function cancel(state: OrderState, orderId: string, reason: string): OrderCancelledPayload {
  if (state.status !== ORDER_STATUS.PLACED) {
    throw new InvalidTransitionError(`cannot cancel order in status ${String(state.status)}`);
  }
  return { orderId, reason };
}
