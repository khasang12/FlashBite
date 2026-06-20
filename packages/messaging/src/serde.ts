import type { SchemaRegistry } from "@kafkajs/confluent-schema-registry";

const idCache = new Map<string, number>();

/**
 * Resolves the latest registered schema id for a subject (cached). Producers are
 * lookup-only: this NEVER registers, and throws if the subject is unregistered.
 */
export async function resolveSchemaId(registry: SchemaRegistry, subject: string): Promise<number> {
  const hit = idCache.get(subject);
  if (hit != null) return hit;
  const id = await registry.getLatestSchemaId(subject);
  idCache.set(subject, id);
  return id;
}

/** Avro-encodes a payload to Confluent wire format using the subject's latest schema. */
export async function encodePayload(registry: SchemaRegistry, subject: string, payload: unknown): Promise<Buffer> {
  return registry.encode(await resolveSchemaId(registry, subject), payload);
}

/** Decodes a Confluent-Avro buffer (schema fetched by id from the wire bytes). */
export async function decodePayload<T = unknown>(registry: SchemaRegistry, value: Buffer): Promise<T> {
  return registry.decode(value) as Promise<T>;
}

/** Test seam: clears the schema-id cache. */
export function __resetIdCache(): void {
  idCache.clear();
}
