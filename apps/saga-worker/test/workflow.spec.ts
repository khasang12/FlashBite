import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { ApplicationFailure } from "@temporalio/activity";
import path from "node:path";
import { orderLifecycleWorkflow, merchantApprovalSignal, confirmPaymentSignal, dispatchResult } from "../src/workflows";
import { DISPATCH_STATUS } from "@flashbite/contracts";

describe("dispatchResult (order maps the dispatch child outcome)", () => {
  it("DELIVERED -> DELIVERED", () => {
    expect(dispatchResult(DISPATCH_STATUS.DELIVERED)).toBe("DELIVERED");
  });
  it("FAILED -> DISPATCH_FAILED", () => {
    expect(dispatchResult(DISPATCH_STATUS.FAILED)).toBe("DISPATCH_FAILED");
  });
});

describe("orderLifecycleWorkflow", () => {
  let env: TestWorkflowEnvironment;
  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
  }, 120000);
  afterAll(async () => {
    await env?.teardown();
  });

  const calls: string[] = [];
  let authorizeResult = true; // toggled per test
  let authorizeThrows = false; // simulate a non-retryable payments 4xx
  const stubActivities = {
    async authorizePaymentActivity() {
      calls.push("authorize");
      if (authorizeThrows) throw ApplicationFailure.nonRetryable("payments authorize failed: 400", "PaymentClientError");
      return { authorized: authorizeResult };
    },
    async capturePaymentActivity() { calls.push("capture"); },
    async voidPaymentActivity() { calls.push("void"); },
    async recordOrderAcceptedActivity() { calls.push("accepted"); },
    async recordOrderCancelledActivity(_t: string, _o: string, reason: string) { calls.push(`cancelled:${reason}`); },
    // dispatch child activities — default: no driver available, so the child fails fast.
    async selectNearestAvailableDriverActivity() { calls.push("select"); return null; },
    async markBusyActivity() { calls.push("busy"); },
    async clearBusyActivity() { calls.push("idle"); },
    async recordDriverOfferedActivity() { calls.push("offered"); },
    async recordDispatchAcceptedActivity() { calls.push("dispatch-accepted"); },
    async recordOrderPickedUpActivity() { calls.push("pickedup"); },
    async recordOrderDeliveredActivity() { calls.push("delivered"); },
    async recordDispatchFailedActivity(_t: string, _o: string, reason: string) { calls.push(`dispatch-failed:${reason}`); },
  };

  async function runWorker<T>(fn: () => Promise<T>): Promise<T> {
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: "test-sla",
      workflowsPath: path.join(__dirname, "../src/workflows.ts"),
      activities: stubActivities,
    });
    return worker.runUntil(fn);
  }

  const baseArgs = (orderId: string, totalAmount = 1200) => ({
    tenantId: "berlin", orderId, totalAmount, slaSeconds: 300, confirmSeconds: 300,
    offerTimeoutSeconds: 2, maxOffers: 1, deliverySeconds: 300, correlationId: "test-corr",
  });

  it("captures + accepts, then runs the dispatch child and maps its result (no driver -> DISPATCH_FAILED)", async () => {
    calls.length = 0; authorizeResult = true;
    const result = await runWorker(async () => {
      const handle = await env.client.workflow.start(orderLifecycleWorkflow, {
        taskQueue: "test-sla",
        workflowId: `berlin:accept-${Date.now()}`,
        args: [baseArgs("o1")],
      });
      await handle.signal(confirmPaymentSignal);
      await handle.signal(merchantApprovalSignal, true);
      return handle.result();
    });
    // After accept the order workflow executes the dispatch child; with no available driver the child
    // ends DispatchFailed and the parent maps it to DISPATCH_FAILED. (Full DELIVERED path: dispatch e2e.)
    expect(result).toBe("DISPATCH_FAILED");
    expect(calls).toEqual(["authorize", "capture", "accepted", "select", "dispatch-failed:NO_DRIVERS_AVAILABLE"]);
  });

  it("CANCELLED_PAYMENT_TIMEOUT when the customer never confirms (time-skipped)", async () => {
    calls.length = 0; authorizeResult = true;
    const result = await runWorker(async () => {
      const handle = await env.client.workflow.start(orderLifecycleWorkflow, {
        taskQueue: "test-sla",
        workflowId: `berlin:noconfirm-${Date.now()}`,
        args: [baseArgs("o0")],
      });
      return handle.result();
    });
    expect(result).toBe("CANCELLED_PAYMENT_TIMEOUT");
    expect(calls).toEqual(["cancelled:PAYMENT_TIMEOUT"]); // never authorized
  });

  it("CANCELLED_SLA when confirmed but no approval before the SLA (time-skipped)", async () => {
    calls.length = 0; authorizeResult = true;
    const result = await runWorker(async () => {
      const handle = await env.client.workflow.start(orderLifecycleWorkflow, {
        taskQueue: "test-sla",
        workflowId: `berlin:breach-${Date.now()}`,
        args: [baseArgs("o2")],
      });
      await handle.signal(confirmPaymentSignal);
      return handle.result();
    });
    expect(result).toBe("CANCELLED_SLA");
    expect(calls).toEqual(["authorize", "void", "cancelled:SLA_BREACH"]);
  });

  it("CANCELLED_DECLINED when confirmed then the merchant declines", async () => {
    calls.length = 0; authorizeResult = true;
    const result = await runWorker(async () => {
      const handle = await env.client.workflow.start(orderLifecycleWorkflow, {
        taskQueue: "test-sla",
        workflowId: `berlin:decline-${Date.now()}`,
        args: [baseArgs("o3")],
      });
      await handle.signal(confirmPaymentSignal);
      await handle.signal(merchantApprovalSignal, false);
      return handle.result();
    });
    expect(result).toBe("CANCELLED_DECLINED");
    expect(calls).toEqual(["authorize", "void", "cancelled:DECLINED"]);
  });

  it("CANCELLED_PAYMENT_FAILED when confirmed but authorize is declined (no capture/void)", async () => {
    calls.length = 0; authorizeResult = false;
    const result = await runWorker(async () => {
      const handle = await env.client.workflow.start(orderLifecycleWorkflow, {
        taskQueue: "test-sla",
        workflowId: `berlin:payfail-${Date.now()}`,
        args: [baseArgs("o4", 100000)],
      });
      await handle.signal(confirmPaymentSignal);
      return handle.result();
    });
    expect(result).toBe("CANCELLED_PAYMENT_FAILED");
    expect(calls).toEqual(["authorize", "cancelled:PAYMENT_FAILED"]);
    authorizeResult = true;
  });

  it("CANCELLED_PAYMENT_FAILED when authorize errors unrecoverably (rejects instead of hanging)", async () => {
    calls.length = 0; authorizeThrows = true;
    const result = await runWorker(async () => {
      const handle = await env.client.workflow.start(orderLifecycleWorkflow, {
        taskQueue: "test-sla",
        workflowId: `berlin:payerr-${Date.now()}`,
        args: [baseArgs("o6", 100000)],
      });
      await handle.signal(confirmPaymentSignal);
      return handle.result();
    });
    expect(result).toBe("CANCELLED_PAYMENT_FAILED");
    expect(calls).toEqual(["authorize", "cancelled:PAYMENT_FAILED"]); // 1 attempt (non-retryable) -> reject
    authorizeThrows = false;
  });
});
