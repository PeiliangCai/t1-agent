import { isT1ApiMethod, t1BackendPath } from "@/t1/gateway-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Fixed loopback business service. Input can never select a host or file path.
const backend = "http://127.0.0.1:3210";
const uploadLimit = 50 * 1024 * 1024;

async function forward(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  const target = t1BackendPath(path);
  if (!target) return Response.json({ error: "t1_route_unavailable" }, { status: 404 });
  if (!isT1ApiMethod(`/api/t1/${path.join("/")}`, request.method)) return Response.json({ error: "t1_method_unavailable" }, { status: 405 });
  const url = new URL(request.url), isEvents = target.endsWith("/events");
  if ([...url.searchParams.keys()].some(key => key !== "after" || !isEvents)) return Response.json({ error: "t1_query_unavailable" }, { status: 400 });
  const cursor = request.headers.get("last-event-id") ?? url.searchParams.get("after");
  if (cursor !== null && (!/^\d+$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))) return Response.json({ error: "invalid_event_cursor" }, { status: 400 });
  const headers = new Headers();
  if (isEvents && cursor !== null) headers.set("last-event-id", cursor);
  let body: Uint8Array | undefined;
  if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
    const upload = target === "/api/workbench/papers" && request.method === "POST" || request.method === "PUT" && target.endsWith("/pdf");
    const type = request.headers.get("content-type")?.split(";", 1)[0].toLowerCase();
    if (type !== (upload ? "application/pdf" : "application/json")) return Response.json({ error: "unsupported_content_type" }, { status: 415 });
    const limit = upload ? uploadLimit : 1024 * 1024;
    if (Number(request.headers.get("content-length")) > limit) return Response.json({ error: "upload_too_large" }, { status: 413 });
    const reader = request.body?.getReader();
    if (!reader) return Response.json({ error: "request_body_required" }, { status: 400 });
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > limit) { await reader.cancel(); return Response.json({ error: "upload_too_large" }, { status: 413 }); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    body = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    headers.set("content-type", upload ? "application/pdf" : "application/json");
    if (upload) for (const name of ["x-t1-filename", "x-t1-title"]) {
      const value = request.headers.get(name);
      if (value) { if (value.length > 4000) return Response.json({ error: "invalid_upload_metadata" }, { status: 400 }); headers.set(name, value); }
    }
  }
  try {
    const upstream = await fetch(backend + target, { method: request.method, body: body as BodyInit | undefined, cache: "no-store", headers, signal: request.signal });
    const responseHeaders = new Headers({
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store", "x-content-type-options": "nosniff", "x-accel-buffering": "no",
      ...(isEvents ? {} : { "content-security-policy": "default-src 'none'; frame-ancestors 'self'" }),
    });
    const disposition = upstream.headers.get("content-disposition");
    if (disposition) responseHeaders.set("content-disposition", disposition);
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch { return Response.json({ error: "t1_backend_unavailable" }, { status: 502 }); }
}

export const GET = forward;
export const HEAD = forward;
export const POST = forward;
export const PUT = forward;
export const PATCH = forward;
export const DELETE = forward;
