import { NextResponse, type NextRequest } from "next/server";
import { isApiRequestAllowed, isApiRequestHostAllowed } from "@/lib/request-security";
import { isT1ApiMethod, isT1ApiPath } from "@/t1/gateway-policy";

/** Mandatory entry boundary: archived upstream coding routes are unreachable. */
export function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const api = path === "/api" || path.startsWith("/api/");
  if (!(api ? isApiRequestAllowed(request) : isApiRequestHostAllowed(request))) {
    return NextResponse.json({ error: "untrusted_request" }, { status: 403 });
  }
  const allowed = api ? isT1ApiPath(path)
    : path === "/" || path.startsWith("/_next/")
      || /^\/t1-assets\/fonts\/(?:noto-cjk\.woff2|OFL\.txt)$/.test(path)
      || /^\/t1-assets\/pdfjs\/(?:pdf\.worker\.min\.mjs|LICENSE|(?:cmaps|standard_fonts|wasm)\/[A-Za-z0-9_.-]+)$/.test(path)
      || /^\/icons\/[A-Za-z0-9_.-]+\.(?:png|svg|ico)$/.test(path) || path === "/favicon.ico";
  const tabIcon = /^\/icons\/catppuccin\/(?:latte|mocha)\/_file\.svg$/.test(path);
  if (!allowed && !tabIcon) return NextResponse.json({ error: "t1_route_unavailable" }, { status: 404 });
  if (!path.startsWith("/_next/") && (api ? !isT1ApiMethod(path, request.method) : request.method !== "GET" && request.method !== "HEAD")) {
    return NextResponse.json({ error: "t1_method_unavailable" }, { status: 405 });
  }
  return NextResponse.next();
}
export const config = { matcher: ["/:path*"] };
