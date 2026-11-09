"use client";
import { useI18n } from "@/hooks/useI18n";
import type { WorkbenchModelRuntime } from "../../../packages/contracts/src/workbench";

export function ModelRuntimeNotice({ runtime, maxConcurrent }: { runtime?: WorkbenchModelRuntime; maxConcurrent?: number }) {
  const { t, locale } = useI18n();
  if (!runtime) return null;
  const number = (value: number) => new Intl.NumberFormat(locale).format(value);
  const seconds = runtime.limits.execution_seconds;
  return <aside className="t1-model-runtime" role="note">
    <p><strong>{t("t1.configuredModel")}: {runtime.model_id} · {runtime.reasoning_effort}</strong></p>
    <p>{t("t1.paidStartOnly")}</p>
    <details><summary>{t("t1.runBudget")}</summary><dl>
      <dt>{t("t1.requestLimit")}</dt><dd>{number(runtime.limits.requests)}</dd>
      <dt>{t("t1.inputTokenLimit")}</dt><dd>{number(runtime.limits.input_tokens)}</dd>
      <dt>{t("t1.outputTokenLimit")}</dt><dd>{number(runtime.limits.output_tokens)}</dd>
      <dt>{t("t1.executionLimit")}</dt><dd>{number(seconds % 60 === 0 ? seconds / 60 : seconds)} {t(seconds % 60 === 0 ? "t1.minutesShort" : "t1.secondsShort")}</dd>
      {maxConcurrent !== undefined && <><dt>{t("t1.concurrentLimit")}</dt><dd>{number(maxConcurrent)}</dd></>}
    </dl><p>{t("t1.queueOutsideExecutionLimit")}</p></details>
  </aside>;
}
