import type { Producer } from "kafkajs";
import type { SchemaRegistry } from "@kafkajs/confluent-schema-registry";
import { TOPICS, EVENT_TYPES, type EventEnvelope } from "@flashbite/contracts";
import { publishEnvelope } from "./publish";
import { readEnvelope } from "./consume";
import { __resetIdCache } from "./serde";

const envelope: EventEnvelope = {
  tenantId: "berlin",
  eventId: "evt-1",
  eventType: EVENT_TYPES.ORDER_PLACED,
  version: 1,
  occurredAt: "2026-06-19T00:00:00.000Z",
  payload: { orderId: "o-1", customerId: "c-1", items: [], totalAmount: 0 },
};

describe("publish/consume helpers", () => {
  beforeEach(() => __resetIdCache());

  it("encodes the payload and sends value + metadata headers", async () => {
    const registry = {
      getLatestSchemaId: jest.fn(async () => 7),
      encode: jest.fn(async () => Buffer.from("avro")),
    } as unknown as SchemaRegistry;
    const producer = { send: jest.fn(async () => undefined) } as unknown as Producer;

    await publishEnvelope(producer, registry, TOPICS.ORDER_EVENTS, "berlin:o-1", envelope);

    expect(registry.encode).toHaveBeenCalledWith(7, envelope.payload);
    expect(producer.send).toHaveBeenCalledWith({
      topic: TOPICS.ORDER_EVENTS,
      messages: [
        {
          key: "berlin:o-1",
          value: Buffer.from("avro"),
          headers: {
            eventType: EVENT_TYPES.ORDER_PLACED,
            tenantId: "berlin",
            eventId: "evt-1",
            version: "1",
            occurredAt: "2026-06-19T00:00:00.000Z",
          },
        },
      ],
    });
  });

  it("throws for an event type without a registered subject", async () => {
    const registry = {} as SchemaRegistry;
    const producer = { send: jest.fn() } as unknown as Producer;
    await expect(
      publishEnvelope(producer, registry, TOPICS.ORDER_EVENTS, "k", { ...envelope, eventType: "Nope" }),
    ).rejects.toThrow(/No Avro subject/);
  });

  it("reassembles the envelope from headers + decoded payload", async () => {
    const registry = { decode: jest.fn(async () => envelope.payload) } as unknown as SchemaRegistry;
    const message = {
      value: Buffer.from("avro"),
      headers: {
        eventType: Buffer.from(EVENT_TYPES.ORDER_PLACED),
        tenantId: Buffer.from("berlin"),
        eventId: Buffer.from("evt-1"),
        version: Buffer.from("1"),
        occurredAt: Buffer.from("2026-06-19T00:00:00.000Z"),
      },
    };
    const result = await readEnvelope(registry, message as never);
    expect(result).toEqual(envelope);
  });

  it("returns null for a message with no value", async () => {
    const registry = {} as SchemaRegistry;
    expect(await readEnvelope(registry, { value: null } as never)).toBeNull();
  });
});
