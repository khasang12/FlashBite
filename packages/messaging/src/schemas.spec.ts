import { loadAvsc } from "./schemas";
import { SUBJECTS } from "@flashbite/contracts";

describe("avsc loader", () => {
  it("loads every subject's schema with matching record name + namespace", () => {
    for (const s of SUBJECTS) {
      const schema = loadAvsc(s.avsc) as { name: string; namespace: string; type: string };
      expect(schema.type).toBe("record");
      expect(schema.name).toBe(s.recordName);
      expect(schema.namespace).toBe("com.flashbite.events");
    }
  });
});
