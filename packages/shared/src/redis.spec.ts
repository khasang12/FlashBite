import { randomUUID } from "node:crypto";
import { createRedisCluster } from "@flashbite/shared";

describe("createRedisCluster", () => {
  it("connects to the cluster and round-trips a hash-tagged key", async () => {
    const cluster = createRedisCluster();
    const info = await cluster.cluster("INFO");
    expect(String(info)).toContain("cluster_state:ok");

    const key = `tenant:{berlin}:probe:${randomUUID()}`;
    await cluster.set(key, "v1", "EX", 10);
    const back = await cluster.get(key);
    expect(back).toBe("v1");

    await cluster.quit();
  });
});
