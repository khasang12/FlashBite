import {
  EVENT_TYPES, DISPATCH_STATUS, type DispatchStatus,
  type DriverOfferedPayload, type DispatchAcceptedPayload,
  type OrderPickedUpPayload, type OrderDeliveredPayload, type DispatchFailedPayload,
} from "@flashbite/contracts";
import { InvalidTransitionError } from "./order-aggregate";

export { InvalidTransitionError };

export interface DispatchState {
  status: DispatchStatus | null;
  offeredDriverId?: string;
  driverId?: string;
  reason?: string;
}

export const INITIAL_DISPATCH_STATE: DispatchState = { status: null };

const TERMINAL: DispatchStatus[] = [DISPATCH_STATUS.DELIVERED, DISPATCH_STATUS.FAILED];

export function foldDispatch(state: DispatchState, event: { eventType: string; payload: unknown }): DispatchState {
  switch (event.eventType) {
    case EVENT_TYPES.DRIVER_OFFERED:
      return { ...state, status: DISPATCH_STATUS.OFFERED, offeredDriverId: (event.payload as DriverOfferedPayload).driverId };
    case EVENT_TYPES.DISPATCH_ACCEPTED:
      return { ...state, status: DISPATCH_STATUS.DISPATCHED, driverId: (event.payload as DispatchAcceptedPayload).driverId };
    case EVENT_TYPES.ORDER_PICKED_UP:
      return { ...state, status: DISPATCH_STATUS.PICKED_UP };
    case EVENT_TYPES.ORDER_DELIVERED:
      return { ...state, status: DISPATCH_STATUS.DELIVERED };
    case EVENT_TYPES.DISPATCH_FAILED:
      return { ...state, status: DISPATCH_STATUS.FAILED, reason: (event.payload as DispatchFailedPayload).reason };
    default:
      return state;
  }
}

export function offer(state: DispatchState, orderId: string, driverId: string): DriverOfferedPayload {
  if (state.status !== null && state.status !== DISPATCH_STATUS.OFFERED) {
    throw new InvalidTransitionError(`cannot offer in status ${String(state.status)}`);
  }
  return { orderId, driverId };
}

export function acceptOffer(state: DispatchState, orderId: string, driverId: string): DispatchAcceptedPayload {
  if (state.status !== DISPATCH_STATUS.OFFERED || state.offeredDriverId !== driverId) {
    throw new InvalidTransitionError(`cannot accept in status ${String(state.status)} by ${driverId}`);
  }
  return { orderId, driverId };
}

export function pickup(state: DispatchState, orderId: string): OrderPickedUpPayload {
  if (state.status !== DISPATCH_STATUS.DISPATCHED) throw new InvalidTransitionError(`cannot pick up in status ${String(state.status)}`);
  return { orderId };
}

export function deliver(state: DispatchState, orderId: string): OrderDeliveredPayload {
  if (state.status !== DISPATCH_STATUS.PICKED_UP) throw new InvalidTransitionError(`cannot deliver in status ${String(state.status)}`);
  return { orderId };
}

export function fail(state: DispatchState, orderId: string, reason: string): DispatchFailedPayload {
  if (state.status !== null && TERMINAL.includes(state.status)) {
    throw new InvalidTransitionError(`cannot fail in terminal status ${String(state.status)}`);
  }
  return { orderId, reason };
}
