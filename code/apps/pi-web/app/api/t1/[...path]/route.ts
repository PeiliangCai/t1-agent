import { t1BackendPath } from "@/t1/gateway-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const backend = "http://127.0.0.1:3210";

export async function GET(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  const target = t1BackendPath(path);
  if (!target) return Response.json({ error: "t1_route_unavailable" }, { status: 404 });
  const url = new URL(request.url), isEvents = target.endsWith("/events");
  if ([...url.searchParams.keys()].some(key => key !== "after" || !isEvents)) {
    return Response.json({ error: "t1_query_unavailable" }, { status: 400 });
  }
  const cursor = request.headers.get("last-event-id") ?? url.searchParams.get("after");
  if (cursor !== null && (!/^\d+$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))) {
    return Response.json({ error: "invalid_event_cursor" }, { status: 400 });
  }
  try {
    const headers: Record<string, string> = {};
    if (isEvents && cursor !== null) headers["last-event-id"] = cursor;
    const upstream = await fetch(backend + target, { cache: "no-store", headers, signal: request.signal });
    return new Response(upstream.body, { status: upstream.status, headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store", "x-content-type-options": "nosniff", "x-accel-buffering": "no",
      ...(isEvents ? {} : { "content-security-policy": "default-src 'none'; frame-ancestors 'self'" }),
    } });
  } catch {
    return Response.json({ error: "t1_backend_unavailable" }, { status: 502 });
  }
}
