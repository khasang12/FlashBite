import { proxyActivities, condition, defineSignal, setHandler } from "@temporalio/workflow";
import { DISPATCH_SAGA, DISPATCH_STATUS, DISPATCH_FAIL_REASONS } from "@flashbite/contracts";
import type { DispatchActivities } from "./dispatch-activities";

export const dispatchAcceptSignal = defineSignal<[string]>(DISPATCH_SAGA.ACCEPT_SIGNAL);
export const dispatchRejectSignal = defineSignal<[string]>(DISPATCH_SAGA.REJECT_SIGNAL);
export const dispatchPickupSignal = defineSignal<[string]>(DISPATCH_SAGA.PICKUP_SIGNAL);
export const dispatchDeliverSignal = defineSignal<[string]>(DISPATCH_SAGA.DELIVER_SIGNAL);

const {
  selectNearestAvailableDriverActivity,
  markBusyActivity,
  clearBusyActivity,
  recordDriverOfferedActivity,
  recordDispatchAcceptedActivity,
  recordOrderPickedUpActivity,
  recordOrderDeliveredActivity,
  recordDispatchFailedActivity,
} = proxyActivities<DispatchActivities>({ startToCloseTimeout: "1 minute", retry: { maximumAttempts: 5 } });

export interface DispatchArgs {
  tenantId: string;
  orderId: string;
  offerTimeoutSeconds: number;
  maxOffers: number;
  /** Max wait (seconds) for pickup and again for delivery after accept; on timeout the dispatch
   *  fails (DELIVERY_TIMEOUT) and the driver is released from the busy set. Default 900. */
  deliverySeconds?: number;
}

export async function driverDispatchWorkflow(args: DispatchArgs): Promise<string> {
  // Use sets keyed by driver id so early-arriving signals survive across loop iterations.
  const accepted = new Set<string>();
  const rejected = new Set<string>();
  let pickedUp = false;
  let delivered = false;

  setHandler(dispatchAcceptSignal, (d) => { accepted.add(d); });
  setHandler(dispatchRejectSignal, (d) => { rejected.add(d); });
  setHandler(dispatchPickupSignal, () => { pickedUp = true; });
  setHandler(dispatchDeliverSignal, () => { delivered = true; });

  const tried: string[] = [];

  for (let i = 0; i < args.maxOffers; i++) {
    const candidate = await selectNearestAvailableDriverActivity(args.tenantId, tried);
    if (!candidate) {
      await recordDispatchFailedActivity(args.tenantId, args.orderId, DISPATCH_FAIL_REASONS.NO_DRIVERS_AVAILABLE);
      return DISPATCH_STATUS.FAILED;
    }

    tried.push(candidate);
    await recordDriverOfferedActivity(args.tenantId, args.orderId, candidate);

    const resolved = await condition(
      () => accepted.has(candidate) || rejected.has(candidate),
      `${args.offerTimeoutSeconds}s`,
    );

    if (!resolved) {
      // Offer timed out — move on to next candidate.
      continue;
    }

    if (accepted.has(candidate)) {
      await markBusyActivity(args.tenantId, candidate);
      await recordDispatchAcceptedActivity(args.tenantId, args.orderId, candidate);
      const deliverySeconds = args.deliverySeconds ?? 900;
      // Bound the post-accept waits so an abandoned job can't pin the driver in the busy set forever.
      const pickedUpInTime = await condition(() => pickedUp, `${deliverySeconds}s`);
      if (!pickedUpInTime) return failAfterAccept(args, candidate);
      await recordOrderPickedUpActivity(args.tenantId, args.orderId);
      const deliveredInTime = await condition(() => delivered, `${deliverySeconds}s`);
      if (!deliveredInTime) return failAfterAccept(args, candidate);
      await recordOrderDeliveredActivity(args.tenantId, args.orderId);
      await clearBusyActivity(args.tenantId, candidate);
      return DISPATCH_STATUS.DELIVERED;
    }

    // Rejected — loop to next candidate.
  }

  await recordDispatchFailedActivity(args.tenantId, args.orderId, DISPATCH_FAIL_REASONS.NO_DRIVERS_AVAILABLE);
  return DISPATCH_STATUS.FAILED;
}

/** Release the driver and fail the dispatch when pickup/delivery doesn't happen in time. */
async function failAfterAccept(args: DispatchArgs, driverId: string): Promise<string> {
  await clearBusyActivity(args.tenantId, driverId);
  await recordDispatchFailedActivity(args.tenantId, args.orderId, DISPATCH_FAIL_REASONS.DELIVERY_TIMEOUT);
  return DISPATCH_STATUS.FAILED;
}
