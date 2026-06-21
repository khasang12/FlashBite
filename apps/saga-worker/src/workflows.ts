import { proxyActivities, condition, defineSignal, setHandler } from "@temporalio/workflow";
import { ORDER_SAGA, ORDER_SAGA_RESULTS, ORDER_CANCEL_REASONS } from "@flashbite/contracts";
import type { Activities } from "./activities";

export const merchantApprovalSignal = defineSignal<[boolean]>(ORDER_SAGA.MERCHANT_APPROVAL_SIGNAL);

const { authorizePaymentActivity, capturePaymentActivity, voidPaymentActivity, recordOrderAcceptedActivity, recordOrderCancelledActivity } =
  proxyActivities<Activities>({ startToCloseTimeout: "1 minute" });

export interface OrderLifecycleArgs {
  tenantId: string;
  orderId: string;
  totalAmount: number;
  slaSeconds: number;
}

/**
 * Authorize a hold -> race the SLA timer against the merchant-approval signal.
 * Declined authorize -> OrderCancelled(PAYMENT_FAILED). Approved in time -> capture + OrderAccepted.
 * Declined or SLA breach -> void + OrderCancelled. Deterministic: all I/O is in activities.
 */
export async function orderLifecycleWorkflow(args: OrderLifecycleArgs): Promise<string> {
  let approved: boolean | undefined;
  setHandler(merchantApprovalSignal, (value) => { approved = value; });

  const { authorized } = await authorizePaymentActivity(args.tenantId, args.orderId, args.totalAmount);
  if (!authorized) {
    await recordOrderCancelledActivity(args.tenantId, args.orderId, ORDER_CANCEL_REASONS.PAYMENT_FAILED);
    return ORDER_SAGA_RESULTS.CANCELLED_PAYMENT_FAILED;
  }

  const signalledInTime = await condition(() => approved !== undefined, `${args.slaSeconds}s`);

  if (signalledInTime && approved) {
    await capturePaymentActivity(args.tenantId, args.orderId);
    await recordOrderAcceptedActivity(args.tenantId, args.orderId);
    return ORDER_SAGA_RESULTS.ACCEPTED;
  }

  await voidPaymentActivity(args.tenantId, args.orderId);
  const reason = signalledInTime ? ORDER_CANCEL_REASONS.DECLINED : ORDER_CANCEL_REASONS.SLA_BREACH;
  await recordOrderCancelledActivity(args.tenantId, args.orderId, reason);
  return reason === ORDER_CANCEL_REASONS.SLA_BREACH ? ORDER_SAGA_RESULTS.CANCELLED_SLA : ORDER_SAGA_RESULTS.CANCELLED_DECLINED;
}
