import { NativeConnection, Worker } from "@temporalio/worker";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const TASK_QUEUE = "spike-sla";
const ADDRESS = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";

async function main() {
  const connection = await NativeConnection.connect({ address: ADDRESS });
  const __dirname = path.dirname(fileURLToPath(import.meta.url));

  const worker = await Worker.create({
    connection,
    namespace: "default",
    taskQueue: TASK_QUEUE,
    workflowsPath: path.join(__dirname, "workflow.ts"),
  });

  console.log(`worker listening on task queue "${TASK_QUEUE}"`);
  await worker.run();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
