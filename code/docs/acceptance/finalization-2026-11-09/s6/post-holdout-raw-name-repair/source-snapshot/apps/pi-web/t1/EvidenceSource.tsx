"use client";
import type { ReactNode } from "react";
import { ImagePreview } from "@/components/ImagePreview";
import { useI18n } from "@/hooks/useI18n";
import type { WorkbenchFigure, WorkbenchFragment } from "../../../packages/contracts/src/workbench";
export function Fragments({ fragments, onPage }: { fragments: WorkbenchFragment[]; onPage: (page: number) => void }) {
  const { t } = useI18n();
  return <div className="t1-fragments">{fragments.map((fragment, index) => <div className="t1-fragment" key={`${fragment.block_id}:${fragment.start}:${index}`}>
    <div className="t1-fragment-location"><button onClick={() => onPage(fragment.physical_page)}>{t("t1.physicalPage", { page: fragment.physical_page })}</button><details><summary>{t("t1.sourceVersion")}</summary><code>{fragment.block_id} · {fragment.start}–{fragment.end} · {fragment.text_version}</code></details></div>
    <p className="t1-verbatim" lang="">{fragment.exact_quote}</p>
  </div>)}</div>;
}
export function FigureView({ figure, onPage, paired = false, review }: { figure: WorkbenchFigure; onPage: (page: number) => void; paired?: boolean; review?: ReactNode }) {
  const { t } = useI18n();
  return <section className="t1-figure" aria-label={`Figure ${figure.number ?? "?"}`}>
    <p className="t1-footnote">{t(paired ? "t1.paired" : "t1.independentFigure")}</p>
    <div className="t1-section-title"><strong>Figure {figure.number ?? "?"}</strong><span>{t(figure.verification === "needs_review" ? "t1.figureNeedsReview" : "t1.figureSourceChecked")}</span></div>
    {figure.assets.map(asset => <div key={asset.id}>
      {/* Original whole-Figure assets must retain their bytes and aspect ratio. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <ImagePreview src={asset.url} alt={`Figure ${figure.number ?? "?"}`}><img src={asset.url} alt={`Figure ${figure.number ?? "?"}`} width={asset.width} height={asset.height} /></ImagePreview>
      <button className="t1-link" onClick={() => onPage(asset.page)}>{t("t1.physicalPage", { page: asset.page })}</button>
    </div>)}
    <div className="t1-caption"><span>{t("t1.caption")}</span><Fragments fragments={figure.caption} onPage={onPage} /></div>{review}
  </section>;
}
