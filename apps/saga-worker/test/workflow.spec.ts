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
  const stubActivities = {
    async chargePaymentActivity() { calls.push("charge"); },
    async refundPaymentActivity() { calls.push("refund"); },
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
    calls.length = 0;
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
    expect(calls).toEqual(["charge", "accepted"]);
  });

  it("CANCELLED_SLA when no signal arrives before the SLA (time-skipped)", async () => {
    calls.length = 0;
    const result = await runWorker(async () => {
      const handle = await env.client.workflow.start(orderLifecycleWorkflow, {
        taskQueue: "test-sla",
        workflowId: `berlin:breach-${Date.now()}`,
        args: [{ tenantId: "berlin", orderId: "o2", totalAmount: 1200, slaSeconds: 300 }],
      });
      return handle.result();
    });
    expect(result).toBe("CANCELLED_SLA");
    expect(calls).toEqual(["charge", "refund", "cancelled:SLA_BREACH"]);
  });

  it("CANCELLED_DECLINED when the merchant declines", async () => {
    calls.length = 0;
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
    expect(calls).toEqual(["charge", "refund", "cancelled:DECLINED"]);
  });
});
