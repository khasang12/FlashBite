import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import path from "node:path";
import { orderLifecycleWorkflow, merchantApprovalSignal } from "../src/workflows";

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

  it("ACCEPTED when the approval signal arrives before the SLA", async () => {
    calls.length = 0; authorizeResult = true;
    const result = await runWorker(async () => {
      const handle = await env.client.workflow.start(orderLifecycleWorkflow, {
        taskQueue: "test-sla",
        workflowId: `berlin:accept-${Date.now()}`,
        args: [{ tenantId: "berlin", orderId: "o1", totalAmount: 1200, slaSeconds: 300 }],
      });
      await handle.signal(merchantApprovalSignal, true);
      return handle.result();
    });
    expect(result).toBe("ACCEPTED");
    expect(calls).toEqual(["authorize", "capture", "accepted"]);
  });

  it("CANCELLED_SLA when no signal arrives before the SLA (time-skipped)", async () => {
    calls.length = 0; authorizeResult = true;
    const result = await runWorker(async () => {
      const handle = await env.client.workflow.start(orderLifecycleWorkflow, {
        taskQueue: "test-sla",
        workflowId: `berlin:breach-${Date.now()}`,
        args: [{ tenantId: "berlin", orderId: "o2", totalAmount: 1200, slaSeconds: 300 }],
      });
      return handle.result();
    });
    expect(result).toBe("CANCELLED_SLA");
    expect(calls).toEqual(["authorize", "void", "cancelled:SLA_BREACH"]);
  });

  it("CANCELLED_DECLINED when the merchant declines", async () => {
    calls.length = 0; authorizeResult = true;
    const result = await runWorker(async () => {
      const handle = await env.client.workflow.start(orderLifecycleWorkflow, {
        taskQueue: "test-sla",
        workflowId: `berlin:decline-${Date.now()}`,
        args: [{ tenantId: "berlin", orderId: "o3", totalAmount: 1200, slaSeconds: 300 }],
      });
      await handle.signal(merchantApprovalSignal, false);
      return handle.result();
    });
    expect(result).toBe("CANCELLED_DECLINED");
    expect(calls).toEqual(["authorize", "void", "cancelled:DECLINED"]);
  });

  it("CANCELLED_PAYMENT_FAILED when authorize is declined (no capture/void)", async () => {
    calls.length = 0; authorizeResult = false;
    const result = await runWorker(async () => {
      const handle = await env.client.workflow.start(orderLifecycleWorkflow, {
        taskQueue: "test-sla",
        workflowId: `berlin:payfail-${Date.now()}`,
        args: [{ tenantId: "berlin", orderId: "o4", totalAmount: 100000, slaSeconds: 300 }],
      });
      return handle.result();
    });
    expect(result).toBe("CANCELLED_PAYMENT_FAILED");
    expect(calls).toEqual(["authorize", "cancelled:PAYMENT_FAILED"]);
    authorizeResult = true;
  });
});
