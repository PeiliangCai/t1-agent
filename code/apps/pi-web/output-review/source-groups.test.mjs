import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { fallbackGroups, validateSourceGroups } from "./source-groups.ts";

const here = dirname(fileURLToPath(import.meta.url));
const pack = JSON.parse(await readFile(join(here, "../public/output-review/pack-manifest.json"), "utf8"));
const clone = value => structuredClone(value);
const viewGroups = (owner_id, arm, view) => ({ owner_id, arm, source_record_sha256: view.source_record_sha256,
  text_fingerprint: view.text_fingerprint, delivery_fingerprint: view.delivery_fingerprint,
  original_groups: fallbackGroups(view.original_fragments), context_groups: fallbackGroups(view.context_fragments) });
const fallback = source => ({ schema_version: "user-feedback-source-groups-1", pack_id: source.pack_id,
  feedback_sha256: "e53f669c7086761f9d0ef209448979aae488068c7b1e2a80d1f5590e422b6a28", policy_version: "test-conservative",
  views: [...source.random_samples.map(s => viewGroups(s.id, "baseline", s.view)), ...source.risks.flatMap(s => [viewGroups(s.id, "before", s.before), viewGroups(s.id, "after", s.after)])] });

test("fallback keeps all original source characters and separates unverified fragments", () => {
  const value = fallback(pack);
  assert.equal(validateSourceGroups(value, pack), value);
  const first = value.views[0].original_groups;
  assert.ok(first.every(group => group.completeness === "unverified" && group.segments.length === 1));
  assert.deepEqual(first.flatMap(group => group.segments), pack.random_samples[0].view.original_fragments);
});

test("group validation rejects missing, changed, repeated or relocated source characters", () => {
  const changes = [
    v => { v.views[0].original_groups[0].segments[0].exact_quote += "补充原文"; },
    v => { v.views[0].original_groups.pop(); },
    v => { v.views[0].original_groups[0].segments[0].start++; },
    v => { v.views[0].original_groups[0].segments[0].physical_page++; },
    v => { v.views[0].original_groups[0].segments[0].bbox[0]++; },
    v => { v.views[0].original_groups[0].segments[0].occurrence++; },
    v => { v.views[0].original_groups[0].segments.push(clone(v.views[0].original_groups[0].segments[0])); },
    v => { v.views[0].context_groups.push(clone(v.views[0].original_groups[0])); },
  ];
  for (const change of changes) { const value = clone(fallback(pack)); change(value); assert.throws(() => validateSourceGroups(value, pack)); }
});

test("split spans use Unicode codepoint offsets and preserve exact raw text including hyphens", () => {
  const synthetic = clone(pack);
  const original = { ...synthetic.random_samples[0].view.original_fragments[0], start: 10, end: 15, exact_quote: "甲🙂-乙。", occurrence: 0 };
  synthetic.random_samples[0].view.original_fragments = [original];
  const value = fallback(synthetic), group = value.views[0].original_groups[0];
  group.segments = [{ ...original, end: 12, exact_quote: "甲🙂" }, { ...original, start: 12, exact_quote: "-乙。" }];
  group.completeness = "complete";
  assert.equal(validateSourceGroups(value, synthetic), value);
  const invalid = clone(value); invalid.views[0].original_groups[0].segments[1].exact_quote = "乙。";
  assert.throws(() => validateSourceGroups(invalid, synthetic));
});

test("sidecar bindings cannot substitute another pack, record arm, fingerprint or duplicate view", () => {
  const changes = [
    v => { v.pack_id = "another-pack"; }, v => { v.views[0].delivery_fingerprint = "0".repeat(64); },
    v => { v.views[0].source_record_sha256 = "0".repeat(64); }, v => { v.views[0].text_fingerprint = "0".repeat(64); },
    v => { v.views[0].arm = "before"; }, v => { v.views.push(clone(v.views[0])); }, v => { v.views.pop(); },
  ];
  for (const change of changes) { const value = fallback(pack); change(value); assert.throws(() => validateSourceGroups(value, pack)); }
});

test("actual derived grouping preserves frozen original and context spans for all 40 bound views", async () => {
  const value = JSON.parse(await readFile(join(here, "../public/output-review/source-groups.json"), "utf8"));
  assert.equal(validateSourceGroups(value, pack), value);
  assert.equal(value.views.length, 40);
});
