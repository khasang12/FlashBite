import { Client, Connection } from "@temporalio/client";
import { approveSignal, slaRaceWorkflow } from "./workflow.js";

const TASK_QUEUE = "spike-sla";
const ADDRESS = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";

async function main() {
  const connection = await Connection.connect({ address: ADDRESS });
  const client = new Client({ connection, namespace: "default" });

  // Case 1: signal arrives in time -> APPROVED
  const h1 = await client.workflow.start(slaRaceWorkflow, {
    args: [30],
    taskQueue: TASK_QUEUE,
    workflowId: `spike-approved-${Date.now()}`,
  });
  await h1.signal(approveSignal, true);
  const r1 = await h1.result();
  if (r1 !== "APPROVED") throw new Error(`expected APPROVED, got ${r1}`);
  console.log(`case 1 (signal in time): ${r1}`);

  // Case 2: no signal, short SLA -> SLA_BREACH
  const h2 = await client.workflow.start(slaRaceWorkflow, {
    args: [2],
    taskQueue: TASK_QUEUE,
    workflowId: `spike-breach-${Date.now()}`,
  });
  const r2 = await h2.result();
  if (r2 !== "SLA_BREACH") throw new Error(`expected SLA_BREACH, got ${r2}`);
  console.log(`case 2 (timer wins): ${r2}`);

  console.log("SPIKE OK: temporal timer-vs-signal race works");
  await connection.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
