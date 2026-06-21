import { Injectable } from "@nestjs/common";
import { loadConfig } from "@flashbite/shared";
import type { PaymentStatus } from "@flashbite/contracts";

/** Reads the order's payment status from the payments service to gate merchant actions (3c-iii). */
@Injectable()
export class PaymentsClient {
  private readonly baseUrl = loadConfig().paymentsUrl;

  async getStatus(tenantId: string, orderId: string): Promise<PaymentStatus | null> {
    const res = await fetch(
      `${this.baseUrl}/payments/${encodeURIComponent(tenantId)}/${encodeURIComponent(orderId)}`,
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`payments GET failed: ${res.status}`);
    const body = (await res.json()) as { status: PaymentStatus };
    return body.status;
  }
}
