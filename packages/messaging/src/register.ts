import { SchemaType } from "@kafkajs/confluent-schema-registry";
import type { SchemaRegistry } from "@kafkajs/confluent-schema-registry";
import { SUBJECTS, subjectFor } from "@flashbite/contracts";
import { createRegistry } from "./registry";
import { loadAvsc } from "./schemas";

export { createRegistry } from "./registry";

const SR_CONTENT_TYPE = "application/vnd.schemaregistry.v1+json";

/** Sets a subject's compatibility level via the registry REST API (not in the client lib). */
export async function setCompatibility(host: string, subject: string, level: string): Promise<void> {
  const res = await fetch(`${host}/config/${encodeURIComponent(subject)}`, {
    method: "PUT",
    headers: { "Content-Type": SR_CONTENT_TYPE },
    body: JSON.stringify({ compatibility: level }),
  });
  if (!res.ok) throw new Error(`set compatibility ${subject}=${level} failed: ${res.status} ${await res.text()}`);
}

/** Registers all SUBJECTS at BACKWARD compatibility. Throws on an incompatible schema. */
export async function registerAllSchemas(registry: SchemaRegistry, host: string): Promise<void> {
  for (const s of SUBJECTS) {
    const subject = subjectFor(s.topic, s.recordName);
    await setCompatibility(host, subject, "BACKWARD");
    const { id } = await registry.register(
      { type: SchemaType.AVRO, schema: JSON.stringify(loadAvsc(s.avsc)) },
      { subject },
    );
    // eslint-disable-next-line no-console
    console.log(`registered ${subject} -> id ${id}`);
  }
}

async function main(): Promise<void> {
  const host = process.env.SCHEMA_REGISTRY_URL ?? "http://localhost:18081";
  await registerAllSchemas(createRegistry(host), host);
  // eslint-disable-next-line no-console
  console.log("schema registration complete");
}

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
