import { SUBJECTS, subjectFor } from "@flashbite/contracts";
import { createRegistry, registerAllSchemas } from "../src/register";

const HOST = process.env.SCHEMA_REGISTRY_URL ?? "http://localhost:18081";

describe("schema registration (live registry)", () => {
  it("registers all subjects so producers can resolve their ids", async () => {
    const registry = createRegistry(HOST);
    await registerAllSchemas(registry, HOST);
    for (const s of SUBJECTS) {
      const id = await registry.getLatestSchemaId(subjectFor(s.topic, s.recordName));
      expect(typeof id).toBe("number");
    }
  });
});
