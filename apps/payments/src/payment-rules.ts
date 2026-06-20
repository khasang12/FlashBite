import { PAYMENT_STATUS, type PaymentStatus } from "@flashbite/contracts";

/** Thrown when a capture/void is attempted from a state that forbids it. */
export class IllegalTransitionError extends Error {
  constructor(from: PaymentStatus, op: string) {
    super(`Cannot ${op} a payment in status ${from}`);
    this.name = "IllegalTransitionError";
  }
}

/** Deterministic gateway decision: decline at/above the threshold. */
export function decideAuthorize(amount: number, declineThreshold: number): PaymentStatus {
  return amount >= declineThreshold ? PAYMENT_STATUS.DECLINED : PAYMENT_STATUS.AUTHORIZED;
}

/** AUTHORIZED -> CAPTURED. Re-capturing a CAPTURED payment is idempotent. */
export function nextOnCapture(current: PaymentStatus): PaymentStatus {
  if (current === PAYMENT_STATUS.CAPTURED) return PAYMENT_STATUS.CAPTURED;
  if (current === PAYMENT_STATUS.AUTHORIZED) return PAYMENT_STATUS.CAPTURED;
  throw new IllegalTransitionError(current, "capture");
}

/** AUTHORIZED -> VOIDED. Re-voiding a VOIDED payment is idempotent. */
export function nextOnVoid(current: PaymentStatus): PaymentStatus {
  if (current === PAYMENT_STATUS.VOIDED) return PAYMENT_STATUS.VOIDED;
  if (current === PAYMENT_STATUS.AUTHORIZED) return PAYMENT_STATUS.VOIDED;
  throw new IllegalTransitionError(current, "void");
}
