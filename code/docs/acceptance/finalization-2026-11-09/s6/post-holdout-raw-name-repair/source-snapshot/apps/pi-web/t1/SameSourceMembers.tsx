"use client";
import { useI18n } from "@/hooks/useI18n";
import type { WorkbenchRecord, WorkbenchSameSourceReviewIndex } from "../../../packages/contracts/src/workbench";

function summary(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (Array.isArray(value)) return value.map(summary).join(" · ") || "—";
  if (typeof value === "object") return Object.entries(value).filter(([key]) => key !== "evidence" && key !== "basis").map(([, part]) => summary(part)).filter(text => text !== "—").join(" · ") || "—";
  return String(value);
}
/** This consumes the server's existing read-only index; it never deduplicates or approves records. */
export function SameSourceMembers({ index, record, records, onSelect }: { index?: WorkbenchSameSourceReviewIndex; record: WorkbenchRecord; records: WorkbenchRecord[]; onSelect: (id: string) => void }) {
  const { t } = useI18n(), group = index?.groups.find(group => group.member_count > 1 && group.members.some(member => member.record_id === record.id));
  if (!group) return null;
  return <details className="t1-same-source"><summary>{t("t1.sameSource", { count: group.member_count })}</summary><p className="t1-footnote">{t("t1.sameSourceHelp")}</p>
    <div className="t1-member-list">{group.members.map((member, i) => {
      const current = records.find(item => item.id === member.record_id);
      return <div key={member.record_id} className={member.record_id === record.id ? "selected" : ""}>
        <button aria-pressed={member.record_id === record.id} onClick={() => onSelect(member.record_id)}>{t("t1.member", { number: i + 1 })} · {t("t1.version", { version: member.record_version })} · {t(current?.text_approved ? "t1.approved" : "t1.pending")}</button>
        <details><summary>{t("t1.memberDifferences")}</summary>{!!group.evidence_field_differences.length && <dl>{group.evidence_field_differences.map(field => <div key={field}><dt>{t(`t1.field.${field}`)}</dt><dd>{summary(member.evidence_fields[field])}</dd></div>)}</dl>}<details><summary>{t("t1.sourceVersion")}</summary><pre>{JSON.stringify(member.evidence_fields, null, 2)}</pre></details></details>
      </div>;
    })}</div>
  </details>;
}
