import { DISPATCH_STATUS } from "@flashbite/contracts";

/** Returns true only while the driver is physically en route to or at the customer. */
export function driverLocationVisible(status: string): boolean {
  return status === DISPATCH_STATUS.DISPATCHED || status === DISPATCH_STATUS.PICKED_UP;
}

export interface DriverLocation {
  lng: number;
  lat: number;
}
