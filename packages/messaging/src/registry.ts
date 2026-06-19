import { SchemaRegistry } from "@kafkajs/confluent-schema-registry";

/** Creates a Schema Registry client. */
export function createRegistry(url: string): SchemaRegistry {
  return new SchemaRegistry({ host: url });
}
