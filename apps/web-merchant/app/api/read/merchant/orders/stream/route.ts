const READ_API = process.env.READ_API_ORIGIN ?? "http://localhost:3002";

// Stream the merchant SSE feed through a Route Handler instead of next.config
// rewrites: rewrites buffer the proxied response, so fetch-based EventSource
// clients never receive incremental events. A Route Handler returning the
// upstream ReadableStream body streams it through. Same-origin, no CORS.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const tenant = request.headers.get("x-tenant-id") ?? "berlin";
  const upstream = await fetch(`${READ_API}/merchant/orders/stream`, {
    headers: { "X-Tenant-ID": tenant, Accept: "text/event-stream" },
    signal: request.signal,
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
