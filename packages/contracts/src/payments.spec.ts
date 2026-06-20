import { ORDER_CANCEL_REASONS, ORDER_SAGA_RESULTS, PAYMENT_STATUS } from "./index";

describe("payment contracts", () => {
  it("adds the payment-failed cancel reason and saga result", () => {
    expect(ORDER_CANCEL_REASONS.PAYMENT_FAILED).toBe("PAYMENT_FAILED");
    expect(ORDER_SAGA_RESULTS.CANCELLED_PAYMENT_FAILED).toBe("CANCELLED_PAYMENT_FAILED");
  });

  it("exposes the payment ledger statuses", () => {
    expect(PAYMENT_STATUS).toEqual({
      AUTHORIZED: "AUTHORIZED",
      CAPTURED: "CAPTURED",
      VOIDED: "VOIDED",
      DECLINED: "DECLINED",
    });
  });
});
