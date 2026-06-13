import { proxyActivities, condition, defineSignal, setHandler } from "@temporalio/workflow";
import { ORDER_SAGA, ORDER_SAGA_RESULTS, ORDER_CANCEL_REASONS } from "@flashbite/contracts";
import type { Activities } from "./activities";

export const merchantApprovalSignal = defineSignal<[boolean]>(ORDER_SAGA.MERCHANT_APPROVAL_SIGNAL);

const { chargePaymentActivity, refundPaymentActivity, recordOrderAcceptedActivity, recordOrderCancelledActivity } =
  proxyActivities<Activities>({ startToCloseTimeout: "1 minute" });

export interface OrderLifecycleArgs {
  tenantId: string;
  orderId: string;
  totalAmount: number;
  slaSeconds: number;
}

/**
 * Charge -> race the SLA timer against the merchant-approval signal.
 * Approved in time -> OrderAccepted. Declined or SLA breach -> refund + OrderCancelled.
 * Deterministic: constants come from the pure @flashbite/contracts module; all I/O is
 * in activities (no node:crypto in the workflow bundle).
 */
export async function orderLifecycleWorkflow(args: OrderLifecycleArgs): Promise<string> {
  let approved: boolean | undefined;
  setHandler(merchantApprovalSignal, (value) => { approved = value; });

  await chargePaymentActivity(args.tenantId, args.orderId, args.totalAmount);

  const signalledInTime = await condition(() => approved !== undefined, `${args.slaSeconds}s`);

  if (signalledInTime && approved) {
    await recordOrderAcceptedActivity(args.tenantId, args.orderId);
    return ORDER_SAGA_RESULTS.ACCEPTED;
  }

  await refundPaymentActivity(args.tenantId, args.orderId, args.totalAmount);
  const reason = signalledInTime ? ORDER_CANCEL_REASONS.DECLINED : ORDER_CANCEL_REASONS.SLA_BREACH;
  await recordOrderCancelledActivity(args.tenantId, args.orderId, reason);
  return reason === ORDER_CANCEL_REASONS.SLA_BREACH ? ORDER_SAGA_RESULTS.CANCELLED_SLA : ORDER_SAGA_RESULTS.CANCELLED_DECLINED;
}
