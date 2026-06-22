import { DISPATCH_STATUS } from "@flashbite/contracts";

/** Display-only mirror of the saga's DISPATCH_OFFER_TIMEOUT_SECONDS default.
 *  The authoritative offer timer lives in the dispatch workflow; this only
 *  drives the UI countdown. */
export const DISPATCH_OFFER_TIMEOUT_SECONDS = 30;

const LABELS: Record<string, string> = {
  [DISPATCH_STATUS.OFFERED]: "New offer",
  [DISPATCH_STATUS.DISPATCHED]: "Accepted — head to pickup",
  [DISPATCH_STATUS.PICKED_UP]: "Picked up — deliver",
  [DISPATCH_STATUS.DELIVERED]: "Delivered",
  [DISPATCH_STATUS.FAILED]: "No longer available",
};

/** Driver-facing label for a dispatch status; unknown values pass through. */
export function dispatchStatusLabel(status: string): string {
  return LABELS[status] ?? status;
}

const DELIVERY_LABELS: Record<string, string> = {
  [DISPATCH_STATUS.OFFERED]: "Finding a driver",
  [DISPATCH_STATUS.DISPATCHED]: "Driver assigned",
  [DISPATCH_STATUS.PICKED_UP]: "Out for delivery",
  [DISPATCH_STATUS.DELIVERED]: "Delivered",
  [DISPATCH_STATUS.FAILED]: "Delivery unavailable",
};

/** Customer/merchant-facing label for a delivery (dispatch) status; unknown values pass through.
 *  Distinct from the driver-facing dispatchStatusLabel (which is phrased as driver actions). */
export function deliveryStatusLabel(status: string): string {
  return DELIVERY_LABELS[status] ?? status;
}
