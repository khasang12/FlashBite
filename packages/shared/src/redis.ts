import { Cluster } from "ioredis";
import { loadConfig, RedisNode } from "./config";

/**
 * The local grokzen cluster announces nodes as 0.0.0.0:<port>; map those to
 * 127.0.0.1 so a host client follows MOVED redirects (proven in Phase 0 Spike D).
 */
export function createRedisCluster(nodes: RedisNode[] = loadConfig().redisClusterNodes): Cluster {
  const natMap = Object.fromEntries(
    nodes.map((n) => [`0.0.0.0:${n.port}`, { host: "127.0.0.1", port: n.port }]),
  );
  return new Cluster(nodes, { natMap });
}
