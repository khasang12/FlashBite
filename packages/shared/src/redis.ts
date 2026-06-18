import { Cluster } from "ioredis";
import { loadConfig, RedisNode } from "./config";

/**
 * Fail fast instead of hanging. ioredis defaults to an unbounded offline queue, so
 * when the cluster is degraded (e.g. a bad grokzen bootstrap leaves slots unassigned)
 * a command that can't be routed waits forever and the caller's request hangs. This
 * caps every command so a broken cluster surfaces as a quick error (→ HTTP 500) rather
 * than a silent stall. Safe because all call sites use non-blocking commands only
 * (get/set/geoadd) — no SUBSCRIBE/BLPOP/XREAD BLOCK. 0 disables. See redis-cluster gotcha.
 */
const DEFAULT_COMMAND_TIMEOUT_MS = 5000;

export function createRedisCluster(
  nodes: RedisNode[] = loadConfig().redisClusterNodes,
  { commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS }: { commandTimeoutMs?: number } = {},
): Cluster {
  // The local grokzen cluster announces nodes as 0.0.0.0:<port>; map those to
  // 127.0.0.1 so a host client follows MOVED redirects (proven in Phase 0 Spike D).
  const natMap = Object.fromEntries(
    nodes.map((n) => [`0.0.0.0:${n.port}`, { host: "127.0.0.1", port: n.port }]),
  );
  return new Cluster(nodes, {
    natMap,
    redisOptions: commandTimeoutMs > 0 ? { commandTimeout: commandTimeoutMs } : {},
  });
}
