"use client";
import { useEffect, useRef, useState } from "react";
import { GlobalWorkerOptions, TextLayer, getDocument, type PDFDocumentProxy, type PDFDocumentLoadingTask } from "pdfjs-dist";

interface Props { url: string; sha256: string; page: number; pages: number; onPage: (page: number) => void }

/** T1 original-page reader, independently controlled by physical page. No annotation or approval state. */
export function PdfSource({ url, sha256, page, pages, onPage }: Props) {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [status, setStatus] = useState("正在取得原件…"), [error, setError] = useState("");
  const [renderedPage, setRenderedPage] = useState<number | null>(null);
  const [width, setWidth] = useState(480), [zoom, setZoom] = useState(1), [revision, setRevision] = useState(0);
  const viewport = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null), text = useRef<HTMLDivElement>(null);

  useEffect(() => {
    GlobalWorkerOptions.workerSrc = "/t1-assets/pdfjs/pdf.worker.min.mjs";
    const abort = new AbortController(); let task: PDFDocumentLoadingTask | undefined;
    setDocument(null); setRenderedPage(null); setError(""); setStatus("正在核验原PDF身份…");
    void (async () => {
      const response = await fetch(url, { signal: abort.signal, cache: "no-store" });
      if (!response.ok) throw new Error("原PDF读取失败");
      const bytes = new Uint8Array(await response.arrayBuffer());
      const hash = await crypto.subtle.digest("SHA-256", bytes);
      const actual = Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, "0")).join("");
      if (actual !== sha256) throw new Error("原PDF身份不一致，未显示");
      if (abort.signal.aborted) return;
      task = getDocument({ data: bytes, useSystemFonts: true, cMapUrl: "/t1-assets/pdfjs/cmaps/", cMapPacked: true,
        standardFontDataUrl: "/t1-assets/pdfjs/standard_fonts/", wasmUrl: "/t1-assets/pdfjs/wasm/" });
      const pdf = await task.promise;
      if (abort.signal.aborted) return;
      if (pdf.numPages !== pages) throw new Error("原PDF物理页数与登记不一致");
      setDocument(pdf); setStatus("原件身份已核验");
    })().catch(cause => { if (!abort.signal.aborted) { setError(cause instanceof Error ? cause.message : "原件不可用"); setStatus("未显示原件"); } });
    return () => { abort.abort(); if (task) void task.destroy(); };
  }, [url, sha256, pages, revision]);

  useEffect(() => {
    if (!viewport.current) return;
    const observer = new ResizeObserver(entries => { const entry = entries[0]; if (entry) setWidth(Math.max(220, entry.contentRect.width - 24)); });
    observer.observe(viewport.current); return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!document || !canvas.current || !text.current) return;
    let cancelled = false;
    let render: ReturnType<Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["render"]> | undefined;
    let layer: TextLayer | undefined;
    const bitmap = canvas.current, textContainer = text.current;
    setRenderedPage(null); setError(""); textContainer.replaceChildren();
    void document.getPage(page).then(async pdfPage => {
      if (cancelled) return;
      const natural = pdfPage.getViewport({ scale: 1 }), scale = width / natural.width * zoom;
      const view = pdfPage.getViewport({ scale }), ratio = window.devicePixelRatio || 1;
      bitmap.width = Math.floor(view.width * ratio); bitmap.height = Math.floor(view.height * ratio);
      bitmap.style.width = `${view.width}px`; bitmap.style.height = `${view.height}px`;
      textContainer.style.width = `${view.width}px`; textContainer.style.height = `${view.height}px`;
      textContainer.style.setProperty("--scale-factor", String(scale)); textContainer.style.setProperty("--total-scale-factor", String(scale)); textContainer.style.setProperty("--min-font-size", "1");
      render = pdfPage.render({ canvas: bitmap, viewport: view, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] });
      layer = new TextLayer({ textContentSource: pdfPage.streamTextContent(), container: textContainer, viewport: view });
      await Promise.all([render.promise, layer.render()]);
      if (!cancelled) { setRenderedPage(page); setStatus(`已显示第 ${page} 物理页 · 共 ${pages} 页`); if (viewport.current) viewport.current.scrollTop = 0; }
    }).catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : "本页显示失败"); });
    return () => { cancelled = true; render?.cancel(); layer?.cancel(); };
  }, [document, page, pages, width, zoom]);

  return <div className="t1-pdf-reader">
    <div className="t1-pdf-controls"><button aria-label="原件上一页" disabled={page <= 1} onClick={() => onPage(page - 1)}>‹</button><label>物理页 <select aria-label="原件物理页" value={page} onChange={event => onPage(Number(event.target.value))}>{Array.from({ length: pages }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1}</option>)}</select> / {pages}</label><button aria-label="原件下一页" disabled={page >= pages} onClick={() => onPage(page + 1)}>›</button><button aria-label="原件缩小" disabled={zoom <= .7} onClick={() => setZoom(value => Math.max(.7, value - .15))}>−</button><button className="t1-pdf-fit" onClick={() => setZoom(1)}>适合宽度</button><button aria-label="原件放大" disabled={zoom >= 2} onClick={() => setZoom(value => Math.min(2, value + .15))}>＋</button></div>
    <div className="t1-pdf-status" role="status">{renderedPage === page ? status : error ? "本页未显示" : document ? `正在显示第 ${page} 物理页…` : status}</div>
    {error && <div className="t1-alert" role="alert">{error}<button onClick={() => setRevision(value => value + 1)}>重新读取原件</button></div>}
    <div className="t1-pdf-viewport" ref={viewport}><div className="t1-pdf-sheet" style={{ visibility: renderedPage === page ? "visible" : "hidden" }}><canvas ref={canvas} data-page={renderedPage ?? ""} aria-label={`原PDF第${renderedPage ?? page}物理页`} /><div ref={text} className="textLayer" /></div></div>
  </div>;
}
