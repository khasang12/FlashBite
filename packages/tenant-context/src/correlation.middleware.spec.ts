import { CorrelationMiddleware } from "./correlation.middleware";
import { getObsContext } from "@flashbite/shared";

function res() {
  const handlers: Record<string, () => void> = {};
  return {
    setHeader: jest.fn(),
    statusCode: 200,
    on: (ev: string, cb: () => void) => { handlers[ev] = cb; },
    finish: () => handlers["finish"]?.(),
  } as any;
}

describe("CorrelationMiddleware", () => {
  const mw = new CorrelationMiddleware({ info: () => {} } as any);

  it("ingests an inbound x-correlation-id header", () => {
    const r = res();
    let seen: string | undefined;
    mw.use({ headers: { "x-correlation-id": "inbound-1" }, method: "GET", originalUrl: "/x" } as any, r, () => { seen = getObsContext()?.correlationId; });
    expect(seen).toBe("inbound-1");
  });

  it("mints a fresh uuid and echoes it on the response when no inbound header", () => {
    const r = res();
    let seen: string | undefined;
    mw.use({ headers: {}, method: "GET", originalUrl: "/x" } as any, r, () => { seen = getObsContext()?.correlationId; });
    expect(seen).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(r.setHeader).toHaveBeenCalledWith("x-correlation-id", seen);
  });

  it("logs one request line on finish with method/path/status/duration", () => {
    const info = jest.fn();
    const m = new CorrelationMiddleware({ info } as any);
    const r = res();
    m.use({ headers: {}, method: "POST", originalUrl: "/orders" } as any, r, () => {});
    r.finish();
    expect(info).toHaveBeenCalledTimes(1);
    const [fields, msg] = info.mock.calls[0];
    expect(msg).toBe("request");
    expect(fields).toMatchObject({ method: "POST", path: "/orders", statusCode: 200 });
    expect(typeof fields.durationMs).toBe("number");
  });
});
