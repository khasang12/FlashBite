import type { DispatchView } from "@flashbite/contracts";

/** Outward-facing delivery view for customer/merchant: dispatch status WITHOUT driver identity. */
export type DeliveryView = Pick<DispatchView, "tenantId" | "orderId" | "status" | "reason" | "version" | "updatedAt">;

export function toDeliveryView(v: DispatchView): DeliveryView {
  return { tenantId: v.tenantId, orderId: v.orderId, status: v.status, reason: v.reason, version: v.version, updatedAt: v.updatedAt };
}
