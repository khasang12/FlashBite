import { proxyActivities, condition, defineSignal, setHandler, executeChild } from "@temporalio/workflow";
import { ORDER_SAGA, ORDER_SAGA_RESULTS, ORDER_CANCEL_REASONS, DISPATCH_STATUS } from "@flashbite/contracts";
import type { Activities } from "./activities";
import { driverDispatchWorkflow } from "./dispatch-workflow";

export const merchantApprovalSignal = defineSignal<[boolean]>(ORDER_SAGA.MERCHANT_APPROVAL_SIGNAL);
export const confirmPaymentSignal = defineSignal(ORDER_SAGA.CONFIRM_PAYMENT_SIGNAL);

const { authorizePaymentActivity, capturePaymentActivity, voidPaymentActivity, recordOrderAcceptedActivity, recordOrderCancelledActivity } =
  proxyActivities<Activities>({
    startToCloseTimeout: "1 minute",
    // Bound retries so a persistently-failing activity (e.g. a payments 4xx) can't loop forever
    // and leave the workflow Running indefinitely. 4xx are thrown non-retryable by the payments
    // client and fail on the first attempt; transient (5xx/network) errors get a few tries.
    retry: { maximumAttempts: 5 },
  });

export interface OrderLifecycleArgs {
  tenantId: string;
  orderId: string;
  totalAmount: number;
  slaSeconds: number;
  confirmSeconds: number;
  // Dispatch knobs threaded into the child driverDispatchWorkflow on acceptance.
  offerTimeoutSeconds: number;
  maxOffers: number;
  deliverySeconds: number;
}

/**
 * Wait for the customer to confirm payment -> authorize a hold -> race the SLA timer against
 * the merchant-approval signal. No confirm in time -> OrderCancelled(PAYMENT_TIMEOUT), no authorize.
 * Declined authorize -> OrderCancelled(PAYMENT_FAILED). Approved in time -> capture + OrderAccepted.
 * Declined or SLA breach -> void + OrderCancelled. Deterministic: all I/O is in activities.
 */
export async function orderLifecycleWorkflow(args: OrderLifecycleArgs): Promise<string> {
  let approved: boolean | undefined;
  let confirmed = false;
  setHandler(merchantApprovalSignal, (value) => { approved = value; });
  setHandler(confirmPaymentSignal, () => { confirmed = true; });

  const confirmedInTime = await condition(() => confirmed, `${args.confirmSeconds}s`);
  if (!confirmedInTime) {
    await recordOrderCancelledActivity(args.tenantId, args.orderId, ORDER_CANCEL_REASONS.PAYMENT_TIMEOUT);
    return ORDER_SAGA_RESULTS.CANCELLED_PAYMENT_TIMEOUT;
  }

  // Authorize. A declined hold OR an unrecoverable error (4xx / retries exhausted) rejects the
  // order — nothing is captured yet, so there is nothing to revert beyond recording the cancel.
  let authorized: boolean;
  try {
    ({ authorized } = await authorizePaymentActivity(args.tenantId, args.orderId, args.totalAmount));
  } catch {
    await recordOrderCancelledActivity(args.tenantId, args.orderId, ORDER_CANCEL_REASONS.PAYMENT_FAILED);
    return ORDER_SAGA_RESULTS.CANCELLED_PAYMENT_FAILED;
  }
  if (!authorized) {
    await recordOrderCancelledActivity(args.tenantId, args.orderId, ORDER_CANCEL_REASONS.PAYMENT_FAILED);
    return ORDER_SAGA_RESULTS.CANCELLED_PAYMENT_FAILED;
  }

  const signalledInTime = await condition(() => approved !== undefined, `${args.slaSeconds}s`);

  if (signalledInTime && approved) {
    // Capture. If it fails unrecoverably, void the hold (best-effort) and reject the order rather
    // than hanging or leaving an un-captured "accepted" order.
    try {
      await capturePaymentActivity(args.tenantId, args.orderId);
    } catch {
      await voidPaymentActivity(args.tenantId, args.orderId).catch(() => undefined);
      await recordOrderCancelledActivity(args.tenantId, args.orderId, ORDER_CANCEL_REASONS.PAYMENT_FAILED);
      return ORDER_SAGA_RESULTS.CANCELLED_PAYMENT_FAILED;
    }
    await recordOrderAcceptedActivity(args.tenantId, args.orderId);
    // Orchestrate the fulfillment leg as a child workflow — one workflow tree per order.
    const dispatchOutcome = await executeChild(driverDispatchWorkflow, {
      workflowId: `dispatch:${args.tenantId}:${args.orderId}`,
      args: [{
        tenantId: args.tenantId,
        orderId: args.orderId,
        offerTimeoutSeconds: args.offerTimeoutSeconds,
        maxOffers: args.maxOffers,
        deliverySeconds: args.deliverySeconds,
      }],
    });
    return dispatchOutcome === DISPATCH_STATUS.DELIVERED
      ? ORDER_SAGA_RESULTS.DELIVERED
      : ORDER_SAGA_RESULTS.DISPATCH_FAILED;
  }

  await voidPaymentActivity(args.tenantId, args.orderId);
  const reason = signalledInTime ? ORDER_CANCEL_REASONS.DECLINED : ORDER_CANCEL_REASONS.SLA_BREACH;
  await recordOrderCancelledActivity(args.tenantId, args.orderId, reason);
  return reason === ORDER_CANCEL_REASONS.SLA_BREACH ? ORDER_SAGA_RESULTS.CANCELLED_SLA : ORDER_SAGA_RESULTS.CANCELLED_DECLINED;
}

export { driverDispatchWorkflow };
