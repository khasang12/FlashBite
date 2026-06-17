const READ_API = process.env.READ_API_ORIGIN ?? "http://localhost:3002";

// Stream the operator/admin cross-tenant SSE feed through a Route Handler.
// Rewrites buffer streaming responses; a Route Handler returning the upstream
// ReadableStream body streams it through incrementally.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const auth = request.headers.get("authorization");
  const upstream = await fetch(`${READ_API}/admin/orders/stream`, {
    headers: { ...(auth ? { Authorization: auth } : {}), Accept: "text/event-stream" },
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
