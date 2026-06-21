import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import path from "node:path";
import {
  driverDispatchWorkflow,
  dispatchAcceptSignal,
  dispatchRejectSignal,
  dispatchPickupSignal,
  dispatchDeliverSignal,
} from "../src/dispatch-workflow";

describe("driverDispatchWorkflow", () => {
  let env: TestWorkflowEnvironment;
  beforeAll(async () => { env = await TestWorkflowEnvironment.createTimeSkipping(); }, 120000);
  afterAll(async () => { await env?.teardown(); });

  const calls: string[] = [];
  let queue: Array<string | null> = [];
  const stub = {
    async selectNearestAvailableDriverActivity(_t: string, tried: string[]) {
      calls.push(`select:[${tried.join(",")}]`);
      return queue.shift() ?? null;
    },
    async markBusyActivity(_t: string, d: string) { calls.push(`busy:${d}`); },
    async clearBusyActivity(_t: string, d: string) { calls.push(`idle:${d}`); },
    async recordDriverOfferedActivity(_t: string, _o: string, d: string) { calls.push(`offered:${d}`); },
    async recordDispatchAcceptedActivity(_t: string, _o: string, d: string) { calls.push(`accepted:${d}`); },
    async recordOrderPickedUpActivity() { calls.push("pickedup"); },
    async recordOrderDeliveredActivity() { calls.push("delivered"); },
    async recordDispatchFailedActivity(_t: string, _o: string, reason: string) { calls.push(`failed:${reason}`); },
  };

  async function run<T>(fn: () => Promise<T>): Promise<T> {
    const worker = await Worker.create({
      connection: env.nativeConnection, taskQueue: "test-dispatch",
      workflowsPath: path.join(__dirname, "../src/dispatch-workflow.ts"), activities: stub,
    });
    return worker.runUntil(fn);
  }
  const args = (orderId: string) => ({ tenantId: "berlin", orderId, offerTimeoutSeconds: 30, maxOffers: 5 });

  it("accept -> pickup -> deliver = DELIVERED", async () => {
    calls.length = 0; queue = ["d1"];
    const result = await run(async () => {
      const h = await env.client.workflow.start(driverDispatchWorkflow, { taskQueue: "test-dispatch", workflowId: `disp-accept-${Date.now()}`, args: [args("o1")] });
      await h.signal(dispatchAcceptSignal, "d1");
      await h.signal(dispatchPickupSignal, "d1");
      await h.signal(dispatchDeliverSignal, "d1");
      return h.result();
    });
    expect(result).toBe("DELIVERED");
    expect(calls).toEqual(["select:[]", "offered:d1", "busy:d1", "accepted:d1", "pickedup", "delivered", "idle:d1"]);
  });

  it("reject re-offers the next-nearest, never the same driver", async () => {
    calls.length = 0; queue = ["d1", "d2"];
    const result = await run(async () => {
      const h = await env.client.workflow.start(driverDispatchWorkflow, { taskQueue: "test-dispatch", workflowId: `disp-reoffer-${Date.now()}`, args: [args("o2")] });
      await h.signal(dispatchRejectSignal, "d1");
      await h.signal(dispatchAcceptSignal, "d2");
      await h.signal(dispatchPickupSignal, "d2");
      await h.signal(dispatchDeliverSignal, "d2");
      return h.result();
    });
    expect(result).toBe("DELIVERED");
    expect(calls).toEqual(["select:[]", "offered:d1", "select:[d1]", "offered:d2", "busy:d2", "accepted:d2", "pickedup", "delivered", "idle:d2"]);
  });

  it("no candidate -> DispatchFailed", async () => {
    calls.length = 0; queue = [null];
    const result = await run(async () => {
      const h = await env.client.workflow.start(driverDispatchWorkflow, { taskQueue: "test-dispatch", workflowId: `disp-fail-${Date.now()}`, args: [args("o3")] });
      return h.result();
    });
    expect(result).toBe("FAILED");
    expect(calls).toEqual(["select:[]", "failed:NO_DRIVERS_AVAILABLE"]);
  });

  it("all offers time out -> DispatchFailed (time-skipped)", async () => {
    calls.length = 0; queue = ["d1", "d2", "d3", "d4", "d5"];
    const result = await run(async () => {
      const h = await env.client.workflow.start(driverDispatchWorkflow, { taskQueue: "test-dispatch", workflowId: `disp-timeout-${Date.now()}`, args: [args("o4")] });
      return h.result();
    });
    expect(result).toBe("FAILED");
    expect(calls.filter((c) => c.startsWith("offered")).length).toBe(5);
    expect(calls.at(-1)).toBe("failed:NO_DRIVERS_AVAILABLE");
  });

  it("accept but no pickup before deliverySeconds -> releases driver + DELIVERY_TIMEOUT (time-skipped)", async () => {
    calls.length = 0; queue = ["d1"];
    const result = await run(async () => {
      const h = await env.client.workflow.start(driverDispatchWorkflow, {
        taskQueue: "test-dispatch", workflowId: `disp-deliverto-${Date.now()}`,
        args: [{ tenantId: "berlin", orderId: "o5", offerTimeoutSeconds: 30, maxOffers: 5, deliverySeconds: 60 }],
      });
      await h.signal(dispatchAcceptSignal, "d1"); // accept, but never pickup -> delivery times out
      return h.result();
    });
    expect(result).toBe("FAILED");
    expect(calls).toEqual(["select:[]", "offered:d1", "busy:d1", "accepted:d1", "idle:d1", "failed:DELIVERY_TIMEOUT"]);
  });
});
