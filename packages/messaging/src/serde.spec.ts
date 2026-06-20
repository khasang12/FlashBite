import type { SchemaRegistry } from "@kafkajs/confluent-schema-registry";
import { encodePayload, decodePayload, resolveSchemaId, __resetIdCache } from "./serde";

function fakeRegistry(over: Partial<SchemaRegistry> = {}): SchemaRegistry {
  return {
    getLatestSchemaId: jest.fn(async () => 42),
    encode: jest.fn(async (_id: number, _payload: unknown) => Buffer.from("avro")),
    decode: jest.fn(async (_buf: Buffer) => ({ orderId: "o-1" })),
    ...over,
  } as unknown as SchemaRegistry;
}

describe("serde", () => {
  beforeEach(() => __resetIdCache());

  it("resolves and caches the schema id per subject", async () => {
    const reg = fakeRegistry();
    await resolveSchemaId(reg, "s");
    await resolveSchemaId(reg, "s");
    expect(reg.getLatestSchemaId).toHaveBeenCalledTimes(1);
  });

  it("encodes the payload at the resolved id", async () => {
    const reg = fakeRegistry();
    const buf = await encodePayload(reg, "s", { orderId: "o-1" });
    expect(reg.encode).toHaveBeenCalledWith(42, { orderId: "o-1" });
    expect(buf).toEqual(Buffer.from("avro"));
  });

  it("decodes a buffer to its payload", async () => {
    const reg = fakeRegistry();
    expect(await decodePayload(reg, Buffer.from("avro"))).toEqual({ orderId: "o-1" });
  });

  it("throws (lookup-only) when the subject is not registered", async () => {
    const reg = fakeRegistry({ getLatestSchemaId: jest.fn(async () => { throw new Error("not found"); }) as never });
    await expect(resolveSchemaId(reg, "missing")).rejects.toThrow("not found");
  });
});
