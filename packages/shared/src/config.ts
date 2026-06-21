export interface RedisNode {
  host: string;
  port: number;
}

export interface AppConfig {
  databaseUrl: string;
  appDatabaseUrl: string;
  kafkaBrokers: string[];
  schemaRegistryUrl: string;
  paymentsUrl: string;
  defaultTenantId: string;
  mongoUri: string;
  redisClusterNodes: RedisNode[];
  temporalAddress: string;
  sagaSlaSeconds: number;
  paymentConfirmTimeoutSeconds: number;
  jwtIssuer: string;
  jwtAudience: string;
  jwtAccessTtl: number;
  jwtJwksUrl: string;
  dispatchOfferTimeoutSeconds: number;
  dispatchMaxOffers: number;
}

export const DEFAULT_TENANT_ID = "berlin";

const DEFAULT_REDIS_NODES = "127.0.0.1:7100,127.0.0.1:7101,127.0.0.1:7102,127.0.0.1:7103,127.0.0.1:7104,127.0.0.1:7105";

/**
 * Returns APP_DATABASE_URL or throws. write-api + saga-worker call this at startup so the
 * service refuses to boot without the restricted `flashbite_app` connection — otherwise a
 * missing var would silently fall back to the superuser DATABASE_URL and DISABLE RLS
 * (fail-open). The loadConfig().appDatabaseUrl fallback remains only for tests, which do
 * not run these entrypoints.
 */
export function requireAppDatabaseUrl(env: Record<string, string | undefined> = process.env): string {
  const url = env.APP_DATABASE_URL;
  if (!url) {
    throw new Error(
      "APP_DATABASE_URL is required so write-api/saga-worker connect as the restricted " +
        "flashbite_app role for Postgres RLS. Set it in .env (see .env.example). Refusing to " +
        "start: falling back to the superuser DATABASE_URL would silently disable tenant isolation.",
    );
  }
  return url;
}

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
    appDatabaseUrl: env.APP_DATABASE_URL ?? databaseUrl,
    kafkaBrokers: (env.KAFKA_BROKERS ?? "localhost:9092").split(","),
    schemaRegistryUrl: env.SCHEMA_REGISTRY_URL ?? "http://localhost:18081",
    paymentsUrl: env.PAYMENTS_URL ?? "http://localhost:3004",
    defaultTenantId: env.DEFAULT_TENANT_ID ?? DEFAULT_TENANT_ID,
    mongoUri: env.MONGO_URI ?? "mongodb://localhost:27017/flashbite_read",
    redisClusterNodes,
    temporalAddress: env.TEMPORAL_ADDRESS ?? "localhost:7233",
    sagaSlaSeconds: Number(env.SAGA_SLA_SECONDS ?? 300),
    paymentConfirmTimeoutSeconds: Number(env.PAYMENT_CONFIRM_TIMEOUT_SECONDS ?? 120),
    jwtIssuer: env.JWT_ISSUER ?? "flashbite-identity",
    jwtAudience: env.JWT_AUDIENCE ?? "flashbite",
    jwtAccessTtl: Number(env.JWT_ACCESS_TTL ?? 3600),
    jwtJwksUrl: env.JWT_JWKS_URL ?? "http://localhost:3003/.well-known/jwks.json",
    dispatchOfferTimeoutSeconds: Number(env.DISPATCH_OFFER_TIMEOUT_SECONDS ?? 30),
    dispatchMaxOffers: Number(env.DISPATCH_MAX_OFFERS ?? 5),
  };
}
