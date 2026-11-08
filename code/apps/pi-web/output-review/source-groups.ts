import type { Fragment, RecordView, ReviewPack } from "./types";

export type SourceGroup = {
  group_id: string;
  kind: string;
  source_type: string;
  segments: Fragment[];
  display_joiner: "\n";
  completeness: "complete" | "incomplete" | "unverified";
  boundary_reasons: string[];
  missing_source_spans: { block_id: string; text_version: string; start: number; end: number }[];
};
export type SourceGroupView = {
  owner_id: string;
  arm: "baseline" | "before" | "after";
  source_record_sha256: string;
  text_fingerprint: string;
  delivery_fingerprint: string;
  original_groups: SourceGroup[];
  context_groups: SourceGroup[];
};
export type SourceGroups = {
  schema_version: "user-feedback-source-groups-1";
  pack_id: string;
  feedback_sha256: string;
  policy_version: string;
  views: SourceGroupView[];
};

/** The sidecar may only partition frozen spans. It cannot add or repair source text. */
function assertPartition(groups: SourceGroup[], originals: Fragment[]) {
  if (!Array.isArray(groups)) throw new Error("源句段分组格式错误");
  let fragmentIndex = 0, consumed = 0;
  const ids = new Set<string>();
  for (const group of groups) {
    if (!group || typeof group.group_id !== "string" || ids.has(group.group_id) || !Array.isArray(group.segments) || !group.segments.length || group.display_joiner !== "\n"
      || !["complete", "incomplete", "unverified"].includes(group.completeness) || !Array.isArray(group.boundary_reasons) || !Array.isArray(group.missing_source_spans)) throw new Error("源句段分组无效");
    ids.add(group.group_id);
    for (const segment of group.segments) {
      const original = originals[fragmentIndex];
      if (!original) throw new Error("源句段超出原始片段");
      const source = Array.from(original.exact_quote);
      const length = segment.end - segment.start;
      if (source.length !== original.end - original.start || !Number.isSafeInteger(segment.start) || !Number.isSafeInteger(segment.end) || length <= 0
        || segment.start !== original.start + consumed || segment.end > original.end
        || segment.exact_quote !== source.slice(consumed, consumed + length).join("")
        || ["block_id", "text_version", "physical_page", "location_precision"].some(key => segment[key as keyof Fragment] !== original[key as keyof Fragment])
        || JSON.stringify(segment.bbox) !== JSON.stringify(original.bbox)
        || !Number.isSafeInteger(segment.occurrence) || segment.occurrence < 0
        || (consumed === 0 && segment.end === original.end && segment.occurrence !== original.occurrence)) throw new Error("源句段与原始定位或逐字文本不一致");
      consumed += length;
      if (consumed === source.length) { fragmentIndex++; consumed = 0; }
    }
  }
  if (fragmentIndex !== originals.length || consumed !== 0) throw new Error("源句段未完整保留原始片段");
}

export function validateSourceGroups(input: unknown, pack: ReviewPack): SourceGroups {
  const value = input as SourceGroups;
  if (!value || value.schema_version !== "user-feedback-source-groups-1" || value.pack_id !== pack.pack_id || !Array.isArray(value.views)
    || typeof value.policy_version !== "string" || !/^[a-f0-9]{64}$/.test(value.feedback_sha256)) throw new Error("源句段辅助材料绑定错误");
  const expected = new Map<string, RecordView>();
  for (const sample of pack.random_samples) expected.set(`${sample.id}:baseline`, sample.view);
  for (const sample of pack.risks) for (const arm of ["before", "after"] as const) expected.set(`${sample.id}:${arm}`, sample[arm]);
  const seen = new Set<string>();
  for (const view of value.views) {
    const key = `${view.owner_id}:${view.arm}`;
    const original = expected.get(key);
    if (!original || seen.has(key) || ["source_record_sha256", "text_fingerprint", "delivery_fingerprint"].some(key => view[key as keyof SourceGroupView] !== original[key as keyof RecordView])) throw new Error("源句段版本或指纹不匹配");
    seen.add(key);
    assertPartition(view.original_groups, original.original_fragments);
    assertPartition(view.context_groups, original.context_fragments);
  }
  if (seen.size !== expected.size) throw new Error("源句段辅助材料缺少视图");
  return value;
}

export function fallbackGroups(fragments: Fragment[]): SourceGroup[] {
  return fragments.map((segment, index) => ({ group_id: `unverified-${index}`, kind: "fragment", source_type: "unknown", segments: [segment], display_joiner: "\n",
    completeness: "unverified", boundary_reasons: ["source_grouping_unavailable"], missing_source_spans: [] }));
}
