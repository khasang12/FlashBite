import { ApplicationFailure } from "@temporalio/activity";
import type { PaymentResponse } from "@flashbite/contracts";

async function post(baseUrl: string, path: string, body: unknown): Promise<PaymentResponse> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const msg = `payments ${path} failed: ${res.status}`;
    // 4xx is a permanent client error (bad request / illegal transition) — never retry it,
    // or the activity loops forever. 5xx / network errors stay retryable (plain Error).
    if (res.status >= 400 && res.status < 500) {
      throw ApplicationFailure.nonRetryable(msg, "PaymentClientError");
    }
    throw new Error(msg);
  }
  return (await res.json()) as PaymentResponse;
}

/** Authorize a hold. Stable idempotency key per order so Temporal retries never double-charge. */
export async function authorizePayment(
  baseUrl: string,
  tenantId: string,
  orderId: string,
  amount: number,
): Promise<{ authorized: boolean }> {
  const r = await post(baseUrl, "/payments/authorize", {
    tenantId,
    orderId,
    amount,
    idempotencyKey: `authorize:${tenantId}:${orderId}`,
  });
  return { authorized: r.outcome !== "declined" };
}

export async function capturePayment(baseUrl: string, tenantId: string, orderId: string): Promise<void> {
  await post(baseUrl, "/payments/capture", { tenantId, orderId, idempotencyKey: `capture:${tenantId}:${orderId}` });
}

export async function voidPayment(baseUrl: string, tenantId: string, orderId: string): Promise<void> {
  await post(baseUrl, "/payments/void", { tenantId, orderId, idempotencyKey: `void:${tenantId}:${orderId}` });
}
