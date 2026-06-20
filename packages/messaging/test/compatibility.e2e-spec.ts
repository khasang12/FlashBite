import { SchemaType } from "@kafkajs/confluent-schema-registry";
import { createRegistry, setCompatibility } from "../src/register";

const HOST = process.env.SCHEMA_REGISTRY_URL ?? "http://localhost:18081";

// A throwaway subject so we never disturb the real ones.
const SUBJECT = "flashbite-compat-probe-value";
const NS = "com.flashbite.probe";

const base = {
  type: "record",
  name: "Probe",
  namespace: NS,
  fields: [{ name: "id", type: "string" }],
};

// BACKWARD-incompatible: a new REQUIRED field with no default (a new-schema reader
// cannot read data written by the old schema).
const incompatible = {
  ...base,
  fields: [...base.fields, { name: "mustHave", type: "string" }],
};

// BACKWARD-compatible: a new OPTIONAL field with a default.
const compatible = {
  ...base,
  fields: [...base.fields, { name: "note", type: ["null", "string"], default: null }],
};

describe("schema compatibility enforcement (live registry)", () => {
  const registry = createRegistry(HOST);

  beforeAll(async () => {
    await setCompatibility(HOST, SUBJECT, "BACKWARD");
    await registry.register({ type: SchemaType.AVRO, schema: JSON.stringify(base) }, { subject: SUBJECT });
  });

  it("rejects a BACKWARD-incompatible change", async () => {
    await expect(
      registry.register({ type: SchemaType.AVRO, schema: JSON.stringify(incompatible) }, { subject: SUBJECT }),
    ).rejects.toThrow();
  });

  it("accepts a BACKWARD-compatible change", async () => {
    const { id } = await registry.register(
      { type: SchemaType.AVRO, schema: JSON.stringify(compatible) },
      { subject: SUBJECT },
    );
    expect(typeof id).toBe("number");
  });
});
