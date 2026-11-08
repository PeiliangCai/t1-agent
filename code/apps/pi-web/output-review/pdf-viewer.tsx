import { useEffect, useRef, useState } from "react";
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type RenderTask } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { Fragment } from "./types";

const assets = new URL("./", import.meta.url);
GlobalWorkerOptions.workerSrc = new URL("pdfjs/pdf.worker.min.mjs", assets).href;
export function assetUrl(path: string): string { return new URL(path, assets).href; }
export type PdfTarget = { page: number; fragments: Fragment[]; token: string };

export function PdfViewer({ documentId, pdfPath, target }: { documentId: string; pdfPath: string; target: PdfTarget }) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(target.page);
  const [pageInput, setPageInput] = useState(String(target.page));
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(600);
  const [rendered, setRendered] = useState<{ page: number; width: number; height: number; scale: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const canvas = useRef<HTMLCanvasElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const pdfUrl = assetUrl(pdfPath);

  useEffect(() => {
    const el = scroll.current;
    if (!el) return;
    const observer = new ResizeObserver(entries => setWidth(Math.max(220, entries[0].contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let active = true;
    setDoc(null); setError(""); setLoading(true); setRendered(null);
    const task = getDocument({
      url: pdfUrl,
      cMapUrl: assetUrl("pdfjs/cmaps/"), cMapPacked: true,
      standardFontDataUrl: assetUrl("pdfjs/standard_fonts/"), wasmUrl: assetUrl("pdfjs/wasm/"),
      useSystemFonts: false, enableXfa: false, disableWorkerRendering: true,
    });
    void task.promise.then(next => { if (active) setDoc(next); }).catch(() => { if (active) { setError("PDF暂时无法显示，可点击“另开原PDF”继续核对。"); setLoading(false); } });
    return () => { active = false; void task.destroy().catch(() => undefined); };
  }, [pdfUrl]);

  useEffect(() => { setPage(target.page); setPageInput(String(target.page)); }, [target.page, target.token, documentId]);

  useEffect(() => {
    if (!doc || !canvas.current) return;
    let active = true;
    let task: RenderTask | undefined;
    setLoading(true); setError(""); setRendered(null);
    const render = async () => {
      const next = await doc.getPage(Math.min(Math.max(page, 1), doc.numPages));
      if (!active || !canvas.current) return;
      const base = next.getViewport({ scale: 1 });
      const scale = Math.max(0.25, (width - 28) / base.width) * zoom;
      const viewport = next.getViewport({ scale });
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      const surface = canvas.current;
      surface.width = Math.ceil(viewport.width * pixelRatio);
      surface.height = Math.ceil(viewport.height * pixelRatio);
      surface.style.width = `${viewport.width}px`;
      surface.style.height = `${viewport.height}px`;
      task = next.render({ canvas: surface, viewport, transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0] });
      await task.promise;
      if (active) { setRendered({ page, width: viewport.width, height: viewport.height, scale }); setLoading(false); }
    };
    void render().catch(err => { if (active && err?.name !== "RenderingCancelledException") { setError("本页暂时无法显示，可另开原PDF核对。换页或调整缩放可重试。"); setLoading(false); } });
    return () => { active = false; task?.cancel(); };
  }, [doc, page, width, zoom]);

  useEffect(() => {
    if (!rendered || rendered.page !== target.page || !target.fragments.length || !scroll.current) return;
    const top = Math.min(...target.fragments.map(f => f.bbox[1])) * rendered.scale;
    const left = Math.min(...target.fragments.map(f => f.bbox[0])) * rendered.scale;
    scroll.current.scrollTop = Math.max(0, top - 100);
    scroll.current.scrollLeft = Math.max(0, left - 60);
  }, [rendered, target]);

  const jump = (n: number) => {
    if (!doc || !Number.isInteger(n) || n < 1 || n > doc.numPages) { setPageInput(String(page)); return; }
    setPage(n); setPageInput(String(n));
  };

  return <section className="pdf-panel" aria-label="论文原PDF">
    <div className="pdf-heading"><strong>论文原PDF · {documentId === "L01" ? "论文一" : "论文二"}</strong><a href={`${pdfUrl}#page=${page}`} target="_blank" rel="noreferrer" data-testid="open-pdf">另开原PDF ↗</a></div>
    <div className="pdf-tools">
      <button type="button" onClick={() => jump(page - 1)} disabled={!doc || page <= 1} aria-label="PDF上一页">‹</button>
      <form onSubmit={event => { event.preventDefault(); jump(Number(pageInput)); }}><label>物理页 <input data-testid="pdf-page" aria-label="PDF物理页" type="number" min="1" max={doc?.numPages ?? 10} value={pageInput} onChange={e => setPageInput(e.target.value)} /></label><span> / {doc?.numPages ?? "…"}</span><button type="submit" disabled={!doc}>跳转</button></form>
      <button type="button" onClick={() => jump(page + 1)} disabled={!doc || page >= doc.numPages} aria-label="PDF下一页">›</button>
      <label>缩放 <select data-testid="pdf-zoom" aria-label="PDF缩放" value={zoom} onChange={e => setZoom(Number(e.target.value))}><option value="0.75">75%</option><option value="1">适合宽度</option><option value="1.25">125%</option><option value="1.5">150%</option><option value="2">200%</option></select></label>
    </div>
    <p className="pdf-help">蓝框只提示大致原文位置，并非精确到每个字。页数按PDF文件顺序。</p>
    {error && <p role="alert" className="notice">{error}</p>}
    <div className="pdf-scroll" ref={scroll} aria-busy={loading} data-testid="pdf-scroll">
      {loading && <p className="pdf-loading" role="status">正在显示PDF…</p>}
      <div className="pdf-page-surface" style={rendered ? { width: rendered.width, height: rendered.height } : undefined}>
        <canvas data-testid="pdf-canvas" ref={canvas} aria-label={`原论文第${page}物理页`} />
        {rendered && rendered.page === target.page && target.fragments.map((fragment, index) => <span key={`${fragment.block_id}:${index}`} data-testid="pdf-highlight" className="pdf-highlight" aria-hidden="true" style={{ left: fragment.bbox[0] * rendered.scale, top: fragment.bbox[1] * rendered.scale, width: Math.max(5, (fragment.bbox[2] - fragment.bbox[0]) * rendered.scale), height: Math.max(5, (fragment.bbox[3] - fragment.bbox[1]) * rendered.scale) }} />)}
      </div>
    </div>
  </section>;
}
