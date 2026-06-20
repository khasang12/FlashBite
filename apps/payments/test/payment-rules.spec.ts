import { PAYMENT_STATUS } from "@flashbite/contracts";
import { decideAuthorize, nextOnCapture, nextOnVoid, IllegalTransitionError } from "../src/payment-rules";

describe("payment rules", () => {
  it("declines at or above the threshold, authorizes below", () => {
    expect(decideAuthorize(99999, 100000)).toBe(PAYMENT_STATUS.AUTHORIZED);
    expect(decideAuthorize(100000, 100000)).toBe(PAYMENT_STATUS.DECLINED);
  });

  it("capture: AUTHORIZED -> CAPTURED, CAPTURED is idempotent, others illegal", () => {
    expect(nextOnCapture(PAYMENT_STATUS.AUTHORIZED)).toBe(PAYMENT_STATUS.CAPTURED);
    expect(nextOnCapture(PAYMENT_STATUS.CAPTURED)).toBe(PAYMENT_STATUS.CAPTURED);
    expect(() => nextOnCapture(PAYMENT_STATUS.VOIDED)).toThrow(IllegalTransitionError);
    expect(() => nextOnCapture(PAYMENT_STATUS.DECLINED)).toThrow(IllegalTransitionError);
  });

  it("void: AUTHORIZED -> VOIDED, VOIDED is idempotent, others illegal", () => {
    expect(nextOnVoid(PAYMENT_STATUS.AUTHORIZED)).toBe(PAYMENT_STATUS.VOIDED);
    expect(nextOnVoid(PAYMENT_STATUS.VOIDED)).toBe(PAYMENT_STATUS.VOIDED);
    expect(() => nextOnVoid(PAYMENT_STATUS.CAPTURED)).toThrow(IllegalTransitionError);
    expect(() => nextOnVoid(PAYMENT_STATUS.DECLINED)).toThrow(IllegalTransitionError);
  });
});
