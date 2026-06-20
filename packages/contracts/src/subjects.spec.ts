import { AVRO_NAMESPACE, SUBJECTS, subjectFor, EVENT_TYPES, TOPICS } from "./index";

describe("avro subjects", () => {
  it("computes TopicRecordNameStrategy subjects", () => {
    expect(AVRO_NAMESPACE).toBe("com.flashbite.events");
    expect(subjectFor(TOPICS.ORDER_EVENTS, "OrderPlaced")).toBe(
      "order-events-com.flashbite.events.OrderPlaced",
    );
  });

  it("has one subject entry per event type, mapped to the right topic", () => {
    const byType = Object.fromEntries(SUBJECTS.map((s) => [s.eventType, s]));
    expect(byType[EVENT_TYPES.ORDER_PLACED].topic).toBe(TOPICS.ORDER_EVENTS);
    expect(byType[EVENT_TYPES.ORDER_ACCEPTED].topic).toBe(TOPICS.ORDER_EVENTS);
    expect(byType[EVENT_TYPES.ORDER_CANCELLED].topic).toBe(TOPICS.ORDER_EVENTS);
    expect(byType[EVENT_TYPES.DRIVER_TELEMETRY_STREAMED].topic).toBe(TOPICS.TELEMETRY_STREAMS);
    expect(SUBJECTS).toHaveLength(4);
  });
});
