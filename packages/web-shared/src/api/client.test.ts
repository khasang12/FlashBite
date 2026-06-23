import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "../store/auth-store";
import {
  acceptOrder,
  confirmPayment,
  declineOrder,
  fetchOrderPayment,
  getAdminDrivers,
  getAdminOrders,
  getNearbyDrivers,
  getOrder,
  getTenants,
  listOrders,
  placeOrder,
  reportLocation,
  UnauthorizedError,
  type PlaceOrderRequest,
  goOnline, goOffline, getDriverOnline, acceptDispatch, rejectDispatch, pickupOrder, deliverOrder, getDispatchForDriver, getOrderDispatch, getMerchantDispatches,
} from "./client";

const fetchMock = vi.fn();

beforeEach(() => {
  useAuthStore.setState({ token: "test-token", claims: { sub: "u", tenantId: "berlin", role: "customer" } });
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

const lastCall = () => fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
const lastUrl = () => lastCall()[0] as string;
const lastHeaders = () => ((lastCall()[1] as RequestInit).headers ?? {}) as Record<string, string>;

describe("api client", () => {
  it("placeOrder sends Bearer, no X-Tenant-ID", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ orderId: "o-1" }), { status: 201 }));

    const req: PlaceOrderRequest = {
      orderId: "o-1",
      customerId: "alice",
      items: [{ sku: "pizza", qty: 1, price: 1200 }],
      totalAmount: 1200,
    };
    const res = await placeOrder(req);

    expect(res).toEqual({ orderId: "o-1" });
    expect(lastUrl()).toBe("/api/write/orders");
    expect((lastCall()[1] as RequestInit).method).toBe("POST");
    expect(lastHeaders().Authorization).toBe("Bearer test-token");
    expect(lastHeaders()["X-Tenant-ID"]).toBeUndefined();
    expect(lastHeaders()["Content-Type"]).toBe("application/json");
    expect(JSON.parse((lastCall()[1] as RequestInit).body as string)).toEqual(req);
  });

  it("getOrder GETs the read proxy with Bearer, no X-Tenant-ID", async () => {
    const view = {
      tenantId: "berlin",
      orderId: "o-1",
      customerId: "alice",
      items: [],
      totalAmount: 1200,
      status: "PLACED",
      version: 1,
      updatedAt: "t",
    };
    fetchMock.mockResolvedValue(new Response(JSON.stringify(view), { status: 200 }));

    const res = await getOrder("o-1");

    expect(res).toEqual(view);
    expect(lastUrl()).toBe("/api/read/orders/o-1");
    expect(lastHeaders().Authorization).toBe("Bearer test-token");
    expect(lastHeaders()["X-Tenant-ID"]).toBeUndefined();
  });

  it("getOrder returns null on 404", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 404 }));
    expect(await getOrder("missing")).toBeNull();
  });

  it("listOrders GETs the merchant list with Bearer, no X-Tenant-ID", async () => {
    const rows = [
      { orderId: "o-1", tenantId: "berlin", customerId: "a", items: [], totalAmount: 0, status: "PLACED", version: 1, updatedAt: "t" },
    ];
    fetchMock.mockResolvedValue(new Response(JSON.stringify(rows), { status: 200 }));

    const res = await listOrders();

    expect(res).toEqual(rows);
    expect(lastUrl()).toBe("/api/read/merchant/orders");
    expect(lastHeaders().Authorization).toBe("Bearer test-token");
    expect(lastHeaders()["X-Tenant-ID"]).toBeUndefined();
  });

  it("acceptOrder POSTs the accept signal with Bearer, no X-Tenant-ID", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 202 }));

    await acceptOrder("o-1");

    expect(lastUrl()).toBe("/api/write/orders/o-1/accept");
    expect((lastCall()[1] as RequestInit).method).toBe("POST");
    expect(lastHeaders().Authorization).toBe("Bearer test-token");
    expect(lastHeaders()["X-Tenant-ID"]).toBeUndefined();
  });

  it("declineOrder POSTs the decline signal with Bearer, no X-Tenant-ID", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 202 }));

    await declineOrder("o-1");

    expect(lastUrl()).toBe("/api/write/orders/o-1/decline");
    expect((lastCall()[1] as RequestInit).method).toBe("POST");
    expect(lastHeaders().Authorization).toBe("Bearer test-token");
    expect(lastHeaders()["X-Tenant-ID"]).toBeUndefined();
  });

  it("reportLocation POSTs to the read proxy with Bearer, no X-Tenant-ID", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ driverId: "drv-1" }), { status: 202 }));

    const res = await reportLocation("drv-1", { lng: 13.4, lat: 52.5 });

    expect(res).toEqual({ driverId: "drv-1" });
    expect(lastUrl()).toBe("/api/read/drivers/drv-1/location");
    expect((lastCall()[1] as RequestInit).method).toBe("POST");
    expect(lastHeaders().Authorization).toBe("Bearer test-token");
    expect(lastHeaders()["X-Tenant-ID"]).toBeUndefined();
    expect(lastHeaders()["Content-Type"]).toBe("application/json");
    expect(JSON.parse((lastCall()[1] as RequestInit).body as string)).toEqual({ lng: 13.4, lat: 52.5 });
  });

  it("reportLocation includes orderId when provided", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ driverId: "drv-1" }), { status: 202 }));

    await reportLocation("drv-1", { lng: 1, lat: 2, orderId: "o-9" });

    expect(JSON.parse((lastCall()[1] as RequestInit).body as string)).toEqual({ lng: 1, lat: 2, orderId: "o-9" });
    expect(lastHeaders()["X-Tenant-ID"]).toBeUndefined();
  });

  it("getNearbyDrivers GETs nearby with coords + radius, Bearer, no X-Tenant-ID", async () => {
    const rows = [{ driverId: "drv-7", distanceKm: 0.4, lng: 13.41, lat: 52.53 }];
    fetchMock.mockResolvedValue(new Response(JSON.stringify(rows), { status: 200 }));

    const res = await getNearbyDrivers(139.7, 35.68, 5);

    expect(res).toEqual(rows);
    expect(lastUrl()).toBe("/api/read/drivers/nearby?lng=139.7&lat=35.68&radiusKm=5");
    expect(lastHeaders().Authorization).toBe("Bearer test-token");
    expect(lastHeaders()["X-Tenant-ID"]).toBeUndefined();
  });

  it("getNearbyDrivers defaults radiusKm to 5", async () => {
    fetchMock.mockResolvedValue(new Response("[]", { status: 200 }));

    await getNearbyDrivers(13.4, 52.5);

    expect(lastUrl()).toBe("/api/read/drivers/nearby?lng=13.4&lat=52.5&radiusKm=5");
    expect(lastHeaders()["X-Tenant-ID"]).toBeUndefined();
  });

  it("getAdminOrders hits /api/read/admin/orders with Bearer, no X-Tenant-ID", async () => {
    const rows = [
      { orderId: "o-2", tenantId: "tokyo", customerId: "b", items: [], totalAmount: 500, status: "PLACED", version: 1, updatedAt: "t" },
    ];
    fetchMock.mockResolvedValue(new Response(JSON.stringify(rows), { status: 200 }));

    const res = await getAdminOrders();

    expect(res).toEqual(rows);
    expect(lastUrl()).toBe("/api/read/admin/orders");
    expect(lastHeaders().Authorization).toBe("Bearer test-token");
    expect(lastHeaders()["X-Tenant-ID"]).toBeUndefined();
  });

  it("getAdminDrivers hits /api/read/admin/drivers with Bearer, no X-Tenant-ID", async () => {
    const rows = [{ driverId: "drv-9", distanceKm: 1.2, lng: 139.7, lat: 35.6, tenantId: "tokyo" }];
    fetchMock.mockResolvedValue(new Response(JSON.stringify(rows), { status: 200 }));

    const res = await getAdminDrivers();

    expect(res).toEqual(rows);
    expect(lastUrl()).toBe("/api/read/admin/drivers");
    expect(lastHeaders().Authorization).toBe("Bearer test-token");
    expect(lastHeaders()["X-Tenant-ID"]).toBeUndefined();
  });

  it("fetchOrderPayment GETs the payment path with Bearer, no X-Tenant-ID", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ status: "AUTHORIZED" }), { status: 200 }));

    const res = await fetchOrderPayment("o-1");

    expect(res).toEqual({ status: "AUTHORIZED" });
    expect(lastUrl()).toBe("/api/read/orders/o-1/payment");
    expect(lastHeaders().Authorization).toBe("Bearer test-token");
    expect(lastHeaders()["X-Tenant-ID"]).toBeUndefined();
  });

  it("fetchOrderPayment passes through { status: null }", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ status: null }), { status: 200 }));
    expect(await fetchOrderPayment("o-2")).toEqual({ status: null });
  });

  it("confirmPayment POSTs the confirm signal with Bearer, no X-Tenant-ID", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 202 }));
    await confirmPayment("o-1");
    expect(lastUrl()).toBe("/api/write/orders/o-1/confirm-payment");
    expect((lastCall()[1] as RequestInit).method).toBe("POST");
    expect(lastHeaders().Authorization).toBe("Bearer test-token");
    expect(lastHeaders()["X-Tenant-ID"]).toBeUndefined();
  });

  it("on 401, clears the session and throws UnauthorizedError", async () => {
    useAuthStore.setState({ token: "expired", claims: { sub: "u", tenantId: "berlin", role: "merchant" } });
    fetchMock.mockResolvedValue(new Response("", { status: 401 }));
    await expect(listOrders()).rejects.toBeInstanceOf(UnauthorizedError);
    expect(useAuthStore.getState().token).toBeNull();
    expect(useAuthStore.getState().claims).toBeNull();
  });

  it("does not clear the session on a non-401 error", async () => {
    useAuthStore.setState({ token: "t", claims: { sub: "u", tenantId: "berlin", role: "merchant" } });
    fetchMock.mockResolvedValue(new Response("", { status: 500 }));
    await expect(listOrders()).rejects.toThrow();
    expect(useAuthStore.getState().token).toBe("t"); // still logged in
  });

  it("goOnline POSTs the read online endpoint with Bearer", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ driverId: "drv-1", online: true }), { status: 202 }));
    const res = await goOnline("drv-1");
    expect(res).toEqual({ driverId: "drv-1", online: true });
    expect(lastUrl()).toBe("/api/read/drivers/drv-1/online");
    expect((lastCall()[1] as RequestInit).method).toBe("POST");
    expect(lastHeaders().Authorization).toBe("Bearer test-token");
  });

  it("goOffline POSTs the read offline endpoint", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ driverId: "drv-1", online: false }), { status: 202 }));
    await goOffline("drv-1");
    expect(lastUrl()).toBe("/api/read/drivers/drv-1/offline");
    expect((lastCall()[1] as RequestInit).method).toBe("POST");
  });

  it("getDriverOnline GETs the read online endpoint and returns the boolean", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ driverId: "drv-1", online: true }), { status: 200 }));
    expect(await getDriverOnline("drv-1")).toBe(true);
    expect(lastUrl()).toBe("/api/read/drivers/drv-1/online");
    expect((lastCall()[1] as RequestInit).method ?? "GET").toBe("GET");
    expect(lastHeaders().Authorization).toBe("Bearer test-token");
  });

  it("acceptDispatch POSTs the write dispatch accept with driverId body", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 202 }));
    await acceptDispatch("o-1", "drv-1");
    expect(lastUrl()).toBe("/api/write/dispatch/o-1/accept");
    expect((lastCall()[1] as RequestInit).method).toBe("POST");
    expect(lastHeaders()["Content-Type"]).toBe("application/json");
    expect(JSON.parse((lastCall()[1] as RequestInit).body as string)).toEqual({ driverId: "drv-1" });
  });

  it("rejectDispatch POSTs the write dispatch reject", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 202 }));
    await rejectDispatch("o-1", "drv-1");
    expect(lastUrl()).toBe("/api/write/dispatch/o-1/reject");
    expect(JSON.parse((lastCall()[1] as RequestInit).body as string)).toEqual({ driverId: "drv-1" });
  });

  it("pickupOrder POSTs the write dispatch pickup", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 202 }));
    await pickupOrder("o-1", "drv-1");
    expect(lastUrl()).toBe("/api/write/dispatch/o-1/pickup");
  });

  it("deliverOrder POSTs the write dispatch deliver", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 202 }));
    await deliverOrder("o-1", "drv-1");
    expect(lastUrl()).toBe("/api/write/dispatch/o-1/deliver");
  });

  it("getDispatchForDriver GETs the driver dispatch read with driverId query", async () => {
    const view = { tenantId: "berlin", orderId: "o-1", status: "OFFERED", offeredDriverId: "drv-1", version: 1, updatedAt: "t" };
    fetchMock.mockResolvedValue(new Response(JSON.stringify(view), { status: 200 }));
    const res = await getDispatchForDriver("drv-1");
    expect(res).toEqual(view);
    expect(lastUrl()).toBe("/api/read/driver/dispatch?driverId=drv-1");
    expect(lastHeaders().Authorization).toBe("Bearer test-token");
  });

  it("getDispatchForDriver passes through { status: null }", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ status: null }), { status: 200 }));
    expect(await getDispatchForDriver("drv-1")).toEqual({ status: null });
  });

  it("getMerchantDispatches GETs the tenant dispatch snapshot with Bearer", async () => {
    const rows = [{ tenantId: "berlin", orderId: "o-1", status: "DISPATCHED", version: 2, updatedAt: "t" }];
    fetchMock.mockResolvedValue(new Response(JSON.stringify(rows), { status: 200 }));
    const res = await getMerchantDispatches();
    expect(res).toEqual(rows);
    expect(lastUrl()).toBe("/api/read/merchant/dispatch");
    expect(lastHeaders().Authorization).toBe("Bearer test-token");
  });

  it("getOrderDispatch GETs the order dispatch read with Bearer", async () => {
    const view = { tenantId: "berlin", orderId: "o-1", status: "DISPATCHED", driverId: "drv-1", version: 2, updatedAt: "t" };
    fetchMock.mockResolvedValue(new Response(JSON.stringify(view), { status: 200 }));
    const res = await getOrderDispatch("o-1");
    expect(res).toEqual(view);
    expect(lastUrl()).toBe("/api/read/orders/o-1/dispatch");
    expect(lastHeaders().Authorization).toBe("Bearer test-token");
  });

  it("getOrderDispatch passes through { status: null }", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ status: null }), { status: 200 }));
    expect(await getOrderDispatch("o-2")).toEqual({ status: null });
  });

  it("getTenants GETs the tenants read with Bearer and returns the catalog", async () => {
    const rows = [{ slug: "berlin", displayName: "Berlin", lng: 13.405, lat: 52.52, status: "active" }];
    fetchMock.mockResolvedValue(new Response(JSON.stringify(rows), { status: 200 }));
    const res = await getTenants();
    expect(res).toEqual(rows);
    expect(lastUrl()).toBe("/api/read/tenants");
    expect(lastHeaders().Authorization).toBe("Bearer test-token");
  });
});
