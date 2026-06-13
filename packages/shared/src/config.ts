export interface AppConfig {
  databaseUrl: string;
  kafkaBrokers: string[];
  defaultTenantId: string;
}

export const DEFAULT_TENANT_ID = "berlin";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  return {
    databaseUrl,
    kafkaBrokers: (env.KAFKA_BROKERS ?? "localhost:9092").split(","),
    defaultTenantId: env.DEFAULT_TENANT_ID ?? DEFAULT_TENANT_ID,
  };
}
