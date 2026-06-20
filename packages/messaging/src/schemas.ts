import { readFileSync } from "node:fs";
import path from "node:path";

// .avsc files live in @flashbite/contracts/avro. Resolved relative to this source
// file (packages/messaging/src -> packages/contracts/avro); the repo runs from source.
const AVRO_DIR = path.join(__dirname, "..", "..", "contracts", "avro");

/** Reads and parses an .avsc file from @flashbite/contracts/avro. */
export function loadAvsc(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(AVRO_DIR, file), "utf8"));
}
