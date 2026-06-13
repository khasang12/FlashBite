export interface RedisNode {
  host: string;
  port: number;
}

export interface AppConfig {
  databaseUrl: string;
  kafkaBrokers: string[];
  defaultTenantId: string;
  mongoUri: string;
  redisClusterNodes: RedisNode[];
}

export const DEFAULT_TENANT_ID = "berlin";

const DEFAULT_REDIS_NODES = "127.0.0.1:7100,127.0.0.1:7101,127.0.0.1:7102,127.0.0.1:7103,127.0.0.1:7104,127.0.0.1:7105";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  const redisClusterNodes = (env.REDIS_CLUSTER_NODES ?? DEFAULT_REDIS_NODES)
    .split(",")
    .map((hp) => {
      const [host, port] = hp.split(":");
      return { host, port: Number(port) };
    });
  return {
    databaseUrl,
    kafkaBrokers: (env.KAFKA_BROKERS ?? "localhost:9092").split(","),
    defaultTenantId: env.DEFAULT_TENANT_ID ?? DEFAULT_TENANT_ID,
    mongoUri: env.MONGO_URI ?? "mongodb://localhost:27017/flashbite_read",
    redisClusterNodes,
  };
}
