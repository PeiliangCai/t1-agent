import assert from "node:assert/strict";
import test from "node:test";
import { applicableChoices, scopeProblems } from "../t1/scope.ts";
import { isT1ApiMethod, isT1ApiPath, t1BackendPath } from "../t1/gateway-policy.ts";

// Synthetic nonmedical identifiers; this catalog is never offered by the production service.
const catalog = { catalog_version: "engineering-only", status: "development_only", fixture: true,
  cancers: [{ id: "a" }, { id: "b" }], image_types: [{ id: "x", cancer_ids: ["a"] }, { id: "y", cancer_ids: ["b"] }],
  features: [], bindings: [{ binding_id: "ax", cancer_ids: ["a"], image_type_ids: ["x"] }, { binding_id: "by", cancer_ids: ["b"], image_type_ids: ["y"] }] };
const scope = { scope_version: "1", catalog_version: catalog.catalog_version, matching_policy_version: "engineering-only",
  cancers: { mode: "all", ids: [] }, image_types: { mode: "all", ids: [] }, features: { mode: "all", binding_ids: [] } };
const data = { catalog, restricted_available: true, development_only: true, default_scope: scope };
test("S5 three unrestricted dimensions need no approved medical vocabulary", () => {
  assert.deepEqual(scopeProblems(scope, { ...data, restricted_available: false }), []);
});
test("S5 restricted empty and stale downstream selections never silently broaden", () => {
  const changed = { ...scope, cancers: { mode: "selected", ids: ["a"] }, image_types: { mode: "selected", ids: ["x", "y"] }, features: { mode: "selected", binding_ids: ["ax", "by"] } };
  const before = structuredClone(changed);
  assert.deepEqual(applicableChoices(changed, catalog).images.map(x => x.id), ["x"]);
  assert.deepEqual(scopeProblems(changed, data), ["image_types_invalid", "features_invalid"]);
  assert.deepEqual(changed, before);
  assert.ok(scopeProblems({ ...scope, features: { mode: "selected", binding_ids: [] } }, data).includes("features_selected_empty"));
});
test("S5 valid multiselect remains exact and unavailable production vocabulary blocks restrictions", () => {
  const selected = { ...scope, cancers: { mode: "selected", ids: ["a", "b"] }, image_types: { mode: "selected", ids: ["x", "y"] }, features: { mode: "selected", binding_ids: ["ax", "by"] } };
  assert.deepEqual(scopeProblems(selected, data), []);
  assert.ok(scopeProblems(selected, { ...data, restricted_available: false }).includes("restricted_unavailable"));
});
test("T1 mutation gateway admits only business methods on their exact routes", () => {
  assert.equal(isT1ApiMethod("/api/t1/workbench/papers", "POST"), true);
  assert.equal(isT1ApiMethod("/api/t1/workbench/papers/p-1/pdf", "PUT"), true);
  assert.equal(isT1ApiMethod("/api/t1/workbench/runs/r-1/records/c-1/review", "POST"), true);
  assert.equal(isT1ApiMethod("/api/t1/workbench/runs/r-1/records/c-1", "PATCH"), true);
  assert.equal(isT1ApiMethod("/api/t1/workbench/runs/r-1/exports/approved_package", "POST"), false);
  assert.equal(isT1ApiMethod("/api/t1/workbench/capabilities", "DELETE"), false);
  assert.equal(isT1ApiMethod("/api/t1/workbench/runs/r-1/cancel", "GET"), false);
  assert.equal(isT1ApiPath("/api/t1/workbench/papers/p-1/../../files"), false);
  assert.equal(isT1ApiPath("/api/agent/new"), false);
  assert.equal(t1BackendPath(["workbench", "runs", "run:1", "figures", "asset:1"]), "/api/workbench/runs/run%3A1/figures/asset%3A1");
});

test("historical ID encoding passes only the allowed colon/comma alphabet without path decoding", () => {
  assert.equal(isT1ApiMethod("/api/t1/workbench/runs/b0%3Arevalidation%2C1/events", "GET"), true);
  assert.equal(isT1ApiMethod("/api/t1/workbench/runs/b0%3arevalidation/records/ev%2c1/review", "POST"), true);
  assert.equal(isT1ApiMethod("/api/t1/workbench/runs/b0%3Arevalidation/cancel", "GET"), false);
  for (const value of ["run%2F1", "run%5C1", "run%253A1", "run%252F1", "%2e%2e", "%252e%252e", "run%00", "run%3Fquery"]) {
    assert.equal(isT1ApiPath(`/api/t1/workbench/runs/${value}`), false, value);
  }
});
