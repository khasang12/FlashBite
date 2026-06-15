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
  temporalAddress: string;
  sagaSlaSeconds: number;
  jwtIssuer: string;
  jwtAudience: string;
  jwtAccessTtl: number;
  jwtJwksUrl: string;
}

export const DEFAULT_TENANT_ID = "berlin";

const DEFAULT_REDIS_NODES = "127.0.0.1:7100,127.0.0.1:7101,127.0.0.1:7102,127.0.0.1:7103,127.0.0.1:7104,127.0.0.1:7105";

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
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
    temporalAddress: env.TEMPORAL_ADDRESS ?? "localhost:7233",
    sagaSlaSeconds: Number(env.SAGA_SLA_SECONDS ?? 300),
    jwtIssuer: env.JWT_ISSUER ?? "flashbite-identity",
    jwtAudience: env.JWT_AUDIENCE ?? "flashbite",
    jwtAccessTtl: Number(env.JWT_ACCESS_TTL ?? 3600),
    jwtJwksUrl: env.JWT_JWKS_URL ?? "http://localhost:3003/.well-known/jwks.json",
  };
}
