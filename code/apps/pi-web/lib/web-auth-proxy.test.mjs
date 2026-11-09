import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { NextRequest } from "next/server.js";

const jiti = createJiti(import.meta.url, {
  alias: { "@": fileURLToPath(new URL("../", import.meta.url)) },
  interopDefault: true,
  moduleCache: false,
});
const { proxy } = await jiti.import("../proxy.ts");
const request = (path, { method = "GET", headers = {} } = {}) => new NextRequest(`http://localhost:30141${path}`, {
  method, headers: { Host: "localhost:30141", ...headers },
});
const accepted = response => { assert.equal(response.status, 200); assert.equal(response.headers.get("x-middleware-next"), "1"); };

// T1's deployed boundary is its Host/Origin checks plus the explicit business allowlist.
// Archived upstream login/session/coding APIs must not become reachable via old credentials.
test("the trusted T1 workbench page remains reachable with its URL state", () => {
  accepted(proxy(request("/?paper=L01&run=run-1&view=records")));
});

test("only the registered T1 read routes pass GET and HEAD", () => {
  for (const path of ["/api/t1/workbench/capabilities", "/api/t1/workbench/catalog", "/api/t1/workbench/papers/L01/pdf", "/api/t1/workbench/runs/run-1/events", "/api/t1/workbench/runs/run-1/exports/approved_package"]) {
    for (const method of ["GET", "HEAD"]) accepted(proxy(request(path, { method })));
  }
});

test("Next's raw encoded historical pathname reaches T1 but encoded path escapes never do", () => {
  accepted(proxy(request("/api/t1/workbench/runs/b0%3Arevalidation%2C1")));
  accepted(proxy(request("/api/t1/workbench/runs/b0%3Arevalidation/records/ev%2C1/review", { method: "POST" })));
  for (const value of ["run%2Fother", "run%5Cother", "run%253A1", "run%252Fother", "%2e%2e", "%252e%252e"]) {
    assert.equal(proxy(request(`/api/t1/workbench/runs/${value}`)).status, 404, value);
  }
});

test("business mutations pass only their explicitly supported path and method", () => {
  for (const [method, path] of [
    ["POST", "/api/t1/workbench/papers"], ["POST", "/api/t1/workbench/papers/p-1/runs"],
    ["POST", "/api/t1/workbench/runs/r-1/cancel"], ["POST", "/api/t1/workbench/runs/r-1/records/c-1/review"],
    ["PATCH", "/api/t1/workbench/runs/r-1/records/c-1"], ["DELETE", "/api/t1/workbench/runs/r-1/records/c-1"],
    ["PUT", "/api/t1/workbench/papers/p-1/pdf"], ["DELETE", "/api/t1/workbench/papers/p-1"],
  ]) accepted(proxy(request(path, { method, headers: { Origin: "http://localhost:30141", "sec-fetch-site": "same-origin" } })));
});

test("a valid business path does not authorize other methods or a GET mutation", () => {
  for (const [method, path] of [["POST", "/api/t1/workbench/capabilities"], ["GET", "/api/t1/workbench/runs/r-1/cancel"], ["GET", "/api/t1/workbench/runs/r-1/records/c-1/review"], ["DELETE", "/"], ["POST", "/api/t1/workbench/runs/r-1/exports/approved_jsonl"]]) {
    assert.equal(proxy(request(path, { method })).status, 405, `${method} ${path}`);
  }
});

test("retired coding and login APIs stay unavailable despite credentials or proxy-bypass headers", () => {
  for (const path of ["/login", "/api/web-auth", "/api/sessions", "/api/agent/new", "/api/terminal", "/api/files/etc/passwd", "/api/models-config/discover", "/api/t1/agent/new"]) {
    for (const headers of [{}, { Authorization: "Basic dGVzdDp0ZXN0", Cookie: "pi_web_session=not-a-session", "x-middleware-subrequest": "proxy:proxy:proxy:proxy:proxy" }]) {
      assert.equal(proxy(request(path, { headers })).status, 404, path);
    }
  }
});

test("an untrusted hostname cannot read the workbench or mutate business data", () => {
  for (const [method, path] of [["GET", "/"], ["GET", "/api/t1/workbench/papers"], ["POST", "/api/t1/workbench/papers"]]) {
    assert.equal(proxy(request(path, { method, headers: { Host: "rebound.invalid:30141" } })).status, 403);
  }
});

test("an operator-configured hostname is accepted without opening arbitrary hosts", () => {
  const previous = process.env.PI_WEB_ALLOWED_HOSTS;
  process.env.PI_WEB_ALLOWED_HOSTS = "t1-preview.example.invalid";
  try {
    accepted(proxy(request("/", { headers: { Host: "t1-preview.example.invalid:30141" } })));
    assert.equal(proxy(request("/", { headers: { Host: "another.example.invalid:30141" } })).status, 403);
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_ALLOWED_HOSTS;
    else process.env.PI_WEB_ALLOWED_HOSTS = previous;
  }
});

test("cross-origin and cross-site browser calls are rejected even for allowed T1 mutations", () => {
  for (const headers of [{ Origin: "https://attacker.invalid" }, { "sec-fetch-site": "cross-site" }, { Origin: "http://localhost:30141", "sec-fetch-site": "cross-site" }]) {
    assert.equal(proxy(request("/api/t1/workbench/papers", { method: "POST", headers })).status, 403);
  }
});

test("same-origin browser and explicitly rewritten same-authority proxy requests are accepted", () => {
  accepted(proxy(request("/api/t1/workbench/papers", { headers: { Origin: "http://localhost:30141", "sec-fetch-site": "same-origin" } })));
  accepted(proxy(request("/api/t1/workbench/papers", { headers: { Origin: "https://localhost:30141", "sec-fetch-site": "same-origin", "x-forwarded-proto": "https" } })));
  assert.equal(proxy(request("/api/t1/workbench/papers", { headers: { Origin: "https://attacker.invalid", "sec-fetch-site": "same-origin", "x-forwarded-proto": "https" } })).status, 403);
});

test("only the fixed static assets required by the workbench are published", () => {
  for (const path of ["/t1-assets/pdfjs/pdf.worker.min.mjs", "/t1-assets/pdfjs/wasm/openjpeg.wasm", "/t1-assets/fonts/noto-cjk.woff2", "/icons/catppuccin/latte/_file.svg"]) accepted(proxy(request(path)));
  for (const path of ["/t1-assets/arbitrary.js", "/output-review/index.html", "/annotation", "/secret.txt"]) assert.equal(proxy(request(path)).status, 404, path);
});
