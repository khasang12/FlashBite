import { SchemaRegistry } from "@kafkajs/confluent-schema-registry";

export type { SchemaRegistry };

/** Creates a Schema Registry client. */
export function createRegistry(url: string): SchemaRegistry {
  return new SchemaRegistry({ host: url });
}
