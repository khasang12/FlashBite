import { describe, it, expect, vi, beforeEach } from "vitest";
import { placeOrder, getOrder, listOrders, acceptOrder, declineOrder, reportLocation, getNearbyDrivers, type PlaceOrderRequest } from "./client";

describe("api client", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("placeOrder POSTs to the write proxy with the tenant header and body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ orderId: "o-1" }), { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const req: PlaceOrderRequest = {
      orderId: "o-1", customerId: "alice",
      items: [{ sku: "pizza", qty: 1, price: 1200 }], totalAmount: 1200,
    };
    const res = await placeOrder("berlin", req);

    expect(res).toEqual({ orderId: "o-1" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/write/orders");
    expect(init.method).toBe("POST");
    expect(init.headers["X-Tenant-ID"]).toBe("berlin");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual(req);
  });

  it("getOrder GETs the read proxy with the tenant header", async () => {
    const view = { tenantId: "berlin", orderId: "o-1", customerId: "alice", items: [], totalAmount: 1200, status: "PLACED", version: 1, updatedAt: "t" };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(view), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await getOrder("berlin", "o-1");
    expect(res).toEqual(view);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/read/orders/o-1");
    expect(init.headers["X-Tenant-ID"]).toBe("berlin");
  });

  it("getOrder returns null on 404", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 404 })));
    expect(await getOrder("berlin", "missing")).toBeNull();
  });

  it("listOrders GETs the merchant list with the tenant header", async () => {
    const rows = [{ orderId: "o-1", tenantId: "berlin", customerId: "a", items: [], totalAmount: 0, status: "PLACED", version: 1, updatedAt: "t" }];
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(rows), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await listOrders("berlin");
    expect(res).toEqual(rows);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/read/merchant/orders");
    expect(init.headers["X-Tenant-ID"]).toBe("berlin");
  });

  it("acceptOrder POSTs the accept signal with the tenant header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    await acceptOrder("berlin", "o-1");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/write/orders/o-1/accept");
    expect(init.method).toBe("POST");
    expect(init.headers["X-Tenant-ID"]).toBe("berlin");
  });

  it("declineOrder POSTs the decline signal", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    await declineOrder("berlin", "o-1");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/write/orders/o-1/decline");
    expect(init.method).toBe("POST");
    expect(init.headers["X-Tenant-ID"]).toBe("berlin");
  });

  it("reportLocation POSTs to the read proxy with the tenant header and body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ driverId: "drv-1" }), { status: 202 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await reportLocation("berlin", "drv-1", { lng: 13.4, lat: 52.5 });

    expect(res).toEqual({ driverId: "drv-1" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/read/drivers/drv-1/location");
    expect(init.method).toBe("POST");
    expect(init.headers["X-Tenant-ID"]).toBe("berlin");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({ lng: 13.4, lat: 52.5 });
  });

  it("reportLocation includes orderId when provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ driverId: "drv-1" }), { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    await reportLocation("berlin", "drv-1", { lng: 1, lat: 2, orderId: "o-9" });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ lng: 1, lat: 2, orderId: "o-9" });
  });

  it("getNearbyDrivers GETs the nearby query with coords + radius and tenant header", async () => {
    const rows = [{ driverId: "drv-7", distanceKm: 0.4, lng: 13.41, lat: 52.53 }];
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(rows), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await getNearbyDrivers("tokyo", 139.7, 35.68, 5);

    expect(res).toEqual(rows);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/read/drivers/nearby?lng=139.7&lat=35.68&radiusKm=5");
    expect(init.headers["X-Tenant-ID"]).toBe("tokyo");
  });

  it("getNearbyDrivers defaults radiusKm to 5", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await getNearbyDrivers("berlin", 13.4, 52.5);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/read/drivers/nearby?lng=13.4&lat=52.5&radiusKm=5");
  });
});
