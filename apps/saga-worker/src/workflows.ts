import { proxyActivities, condition, defineSignal, setHandler } from "@temporalio/workflow";
import type { Activities } from "./activities";

export const merchantApprovalSignal = defineSignal<[boolean]>("merchantApproval");

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
 * Deterministic: all I/O is in activities; no contracts/node imports here.
 */
export async function orderLifecycleWorkflow(args: OrderLifecycleArgs): Promise<string> {
  let approved: boolean | undefined;
  setHandler(merchantApprovalSignal, (value) => { approved = value; });

  await chargePaymentActivity(args.tenantId, args.orderId, args.totalAmount);

  const signalledInTime = await condition(() => approved !== undefined, `${args.slaSeconds}s`);

  if (signalledInTime && approved) {
    await recordOrderAcceptedActivity(args.tenantId, args.orderId);
    return "ACCEPTED";
  }

  await refundPaymentActivity(args.tenantId, args.orderId, args.totalAmount);
  const reason = signalledInTime ? "DECLINED" : "SLA_BREACH";
  await recordOrderCancelledActivity(args.tenantId, args.orderId, reason);
  return reason === "SLA_BREACH" ? "CANCELLED_SLA" : "CANCELLED_DECLINED";
}
