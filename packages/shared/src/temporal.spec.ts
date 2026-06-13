import { connectTemporal } from "@flashbite/shared";

describe("connectTemporal", () => {
  it("connects to the Temporal frontend", async () => {
    const { connection, client } = await connectTemporal();
    expect(client).toBeDefined();
    await connection.workflowService.getSystemInfo({});
    await connection.close();
  });
});
