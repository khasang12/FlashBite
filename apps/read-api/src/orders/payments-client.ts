import { Injectable } from "@nestjs/common";
import { loadConfig } from "@flashbite/shared";
import type { PaymentStatus } from "@flashbite/contracts";

/**
 * Server-to-server client for the payments service (Phase 3c-ii). read-api is the only
 * caller the frontends reach; payments stays internal. Maps a 404 to `null` so the
 * controller can return `{ status: null }` ("no payment yet") distinctly from an error.
 */
@Injectable()
export class PaymentsClient {
  private readonly baseUrl = loadConfig().paymentsUrl;

  async getPayment(tenantId: string, orderId: string): Promise<{ status: PaymentStatus } | null> {
    const res = await fetch(
      `${this.baseUrl}/payments/${encodeURIComponent(tenantId)}/${encodeURIComponent(orderId)}`,
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`payments GET failed: ${res.status}`);
    const body = (await res.json()) as { status: PaymentStatus };
    return { status: body.status };
  }
}
