import { firstValueFrom } from "rxjs";
import { take, toArray } from "rxjs/operators";
import { OrderStreamService } from "../src/sse/order-stream.service";

describe("OrderStreamService", () => {
  it("delivers events to subscribers of the same tenant", async () => {
    const svc = new OrderStreamService();
    const got = firstValueFrom(svc.stream("berlin").pipe(take(1)));
    svc.publish("berlin", { orderId: "o-1", eventType: "OrderPlaced", status: "PLACED" });
    expect(await got).toMatchObject({ orderId: "o-1" });
  });

  it("isolates tenants — a tokyo event never reaches a berlin subscriber", async () => {
    const svc = new OrderStreamService();
    const berlin = firstValueFrom(svc.stream("berlin").pipe(take(1), toArray()));
    svc.publish("tokyo", { orderId: "t-1", eventType: "OrderPlaced", status: "PLACED" });
    svc.publish("berlin", { orderId: "b-1", eventType: "OrderPlaced", status: "PLACED" });
    const received = await berlin;
    expect(received).toHaveLength(1);
    expect(received[0].orderId).toBe("b-1");
  });
});
