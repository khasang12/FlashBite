import { authorizePayment, capturePayment, voidPayment } from "../src/payments-client";

describe("payments-client", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  function stub(status: number, body: unknown) {
    globalThis.fetch = (async () => ({ ok: status < 400, status, json: async () => body })) as unknown as typeof fetch;
  }

  it("authorize maps outcome to a boolean and sends an idempotency key", async () => {
    const calls: Array<{ url: string; body: any }> = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return { ok: true, status: 201, json: async () => ({ paymentId: "p1", outcome: "authorized" }) };
    }) as unknown as typeof fetch;

    const r = await authorizePayment("http://pay", "berlin", "o1", 1200);
    expect(r.authorized).toBe(true);
    expect(calls[0].url).toBe("http://pay/payments/authorize");
    expect(calls[0].body).toMatchObject({ tenantId: "berlin", orderId: "o1", amount: 1200, idempotencyKey: "authorize:berlin:o1" });
  });

  it("authorize returns authorized=false on a declined outcome", async () => {
    stub(201, { paymentId: "p1", outcome: "declined" });
    expect((await authorizePayment("http://pay", "berlin", "o1", 100000)).authorized).toBe(false);
  });

  it("capture/void resolve on 2xx", async () => {
    stub(201, { paymentId: "p1", outcome: "captured" });
    await expect(capturePayment("http://pay", "berlin", "o1")).resolves.toBeUndefined();
    stub(201, { paymentId: "p1", outcome: "voided" });
    await expect(voidPayment("http://pay", "berlin", "o1")).resolves.toBeUndefined();
  });

  it("throws on a non-2xx response (so Temporal retries)", async () => {
    stub(500, { error: "boom" });
    await expect(capturePayment("http://pay", "berlin", "o1")).rejects.toThrow();
  });
});
