import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import path from "node:path";
import { orderLifecycleWorkflow, merchantApprovalSignal, confirmPaymentSignal } from "../src/workflows";

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
  const stubActivities = {
    async authorizePaymentActivity() { calls.push("authorize"); return { authorized: authorizeResult }; },
    async capturePaymentActivity() { calls.push("capture"); },
    async voidPaymentActivity() { calls.push("void"); },
    async recordOrderAcceptedActivity() { calls.push("accepted"); },
    async recordOrderCancelledActivity(_t: string, _o: string, reason: string) { calls.push(`cancelled:${reason}`); },
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
  });

  it("ACCEPTED when confirmed, then approved before the SLA", async () => {
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
    expect(result).toBe("ACCEPTED");
    expect(calls).toEqual(["authorize", "capture", "accepted"]);
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
});
