import { useEffect, useRef, useState, type RefObject } from "react";
import * as pdfjs from "pdfjs-dist";
import type { PDFPageProxy, RenderTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import ui from "../ui.module.css";
import { cx } from "../cx";
import { indexOfToken, normalize } from "../provenance";
import styles from "./PdfViewer.module.css";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** Gap around and between pages, in CSS pixels. Keep in sync with .pages padding/gap. */
const GAP = 12;
const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
/** Mobile browsers refuse (or silently blank) canvases much above ~16M pixels. */
const MAX_CANVAS_PIXELS = 12_000_000;

type PageInfo = { page: PDFPageProxy; width: number; height: number };

/**
 * Renders a PDF with PDF.js into canvases, one per page, with a selectable text layer.
 * Used instead of an <iframe>, which mobile browsers (Android Chrome in particular) don't render.
 * This module pulls in PDF.js, so load it with React.lazy.
 */
export default function PdfViewer({ url, highlight }: { url: string; highlight?: string[] | null }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [pages, setPages] = useState<PageInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [width, setWidth] = useState(0);
  /** Multiplier on "fit to width". */
  const [zoom, setZoom] = useState(1);
  const [current, setCurrent] = useState(1);
  /** Bumped whenever a page's text layer finishes drawing, so highlights are reapplied. */
  const [drawn, setDrawn] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setPages(null);
    setError(null);
    setCurrent(1);
    const task = pdfjs.getDocument({ url });
    task.promise
      .then(async (d) => {
        const loaded = await Promise.all(
          Array.from({ length: d.numPages }, async (_, i) => {
            const page = await d.getPage(i + 1);
            const vp = page.getViewport({ scale: 1 });
            return { page, width: vp.width, height: vp.height };
          }),
        );
        if (!cancelled) setPages(loaded);
      })
      .catch((e: Error) => { if (!cancelled) setError(e.message); });
    return () => {
      cancelled = true;
      void task.destroy(); // also destroys the loaded document
    };
  }, [url]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Track which page is mostly in view for the "n / total" indicator.
  useEffect(() => {
    const el = scroller.current;
    if (!el || !pages) return;
    const onScroll = () => {
      const mid = el.scrollTop + el.clientHeight / 2;
      let n = 1;
      for (const child of el.querySelectorAll<HTMLElement>("[data-page]")) {
        if (child.offsetTop <= mid) n = Number(child.dataset.page);
      }
      setCurrent(n);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [pages]);

  // Highlight where a value appears: mark the text-layer spans it covers and bring the first into view.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    el.querySelectorAll(`.${styles.hit}`).forEach((s) => s.classList.remove(styles.hit));
    if (!highlight?.length) return;
    const first = markText(el, highlight, styles.hit);
    if (first) {
      const box = el.getBoundingClientRect();
      const r = first.getBoundingClientRect();
      if (r.top < box.top + 30 || r.bottom > box.bottom - 30) el.scrollTo({ top: el.scrollTop + r.top - box.top - box.height / 3, behavior: "smooth" });
    }
  }, [highlight, drawn]);

  const widest = pages ? Math.max(...pages.map((p) => p.width)) : 1;
  const fit = width > 0 ? Math.max(0.1, (width - 2 * GAP) / widest) : 0;
  const scale = fit * zoom;
  const stepZoom = (dir: 1 | -1) => {
    const i = ZOOM_STEPS.findIndex((z) => z >= zoom - 1e-6);
    const next = ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, (i < 0 ? ZOOM_STEPS.length : i) + dir))];
    // Keep the same spot in view: scale the scroll offsets by the zoom ratio.
    const el = scroller.current;
    if (el) {
      const r = next / zoom;
      requestAnimationFrame(() => {
        el.scrollTop = (el.scrollTop + el.clientHeight / 2) * r - el.clientHeight / 2;
        el.scrollLeft = (el.scrollLeft + el.clientWidth / 2) * r - el.clientWidth / 2;
      });
    }
    setZoom(next);
  };

  return (
    <div className={styles.viewer}>
      <div className={styles.toolbar}>
        <span className={cx(ui.small, styles.pageCount)}>{pages ? `${current} / ${pages.length}` : ""}</span>
        <span className={ui.spacer} />
        <button className={ui.compact} onClick={() => stepZoom(-1)} disabled={zoom <= ZOOM_STEPS[0]} aria-label="Zoom out">−</button>
        <button className={ui.compact} onClick={() => setZoom(1)} disabled={zoom === 1} title="Fit to width">{Math.round(zoom * 100)}%</button>
        <button className={ui.compact} onClick={() => stepZoom(1)} disabled={zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1]} aria-label="Zoom in">+</button>
      </div>
      <div ref={scroller} className={styles.scroller}>
        {error ? (
          <p className={styles.message}>Couldn't show this PDF: {error}</p>
        ) : !pages ? (
          <p className={styles.message}>Loading…</p>
        ) : (
          scale > 0 && (
            <div className={styles.pages}>
              {pages.map((p, i) => <Page key={i} n={i + 1} info={p} scale={scale} root={scroller} onText={() => setDrawn((n) => n + 1)} />)}
            </div>
          )
        )}
      </div>
    </div>
  );
}

function Page({ n, info, scale, root, onText }: { n: number; info: PageInfo; scale: number; root: RefObject<HTMLDivElement | null>; onText: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const textLayer = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);

  // Only pages near the viewport keep a canvas, so long documents don't exhaust a phone's memory.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setNear(e.isIntersecting), { root: root.current, rootMargin: "150% 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [root]);

  useEffect(() => {
    const c = canvas.current;
    const tl = textLayer.current;
    if (!near || !c || !tl) return;
    const viewport = info.page.getViewport({ scale });
    const dpr = Math.min(window.devicePixelRatio || 1, Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height)));
    c.width = Math.floor(viewport.width * dpr);
    c.height = Math.floor(viewport.height * dpr);
    let render: RenderTask | null = info.page.render({
      canvas: c,
      viewport,
      transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
    });
    render.promise.catch(() => {}); // cancelled renders reject
    const text = new pdfjs.TextLayer({ textContentSource: info.page.streamTextContent(), container: tl, viewport });
    text.render().then(onText, () => {});
    return () => {
      render?.cancel();
      render = null;
      text.cancel();
      tl.replaceChildren();
    };
  }, [near, info, scale]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      ref={box}
      data-page={n}
      className={styles.page}
      style={{
        width: Math.floor(info.width * scale),
        height: Math.floor(info.height * scale),
        // Read by PDF.js's text layer to size and place the text spans.
        ["--total-scale-factor" as string]: scale,
      }}
    >
      {near && <canvas ref={canvas} className={styles.canvas} />}
      {near && <div ref={textLayer} className={styles.textLayer} />}
    </div>
  );
}

/**
 * Marks the text-layer spans that hold one of the needles (first match per
 * page, words may span several spans). Returns the first marked span.
 */
function markText(root: HTMLElement, needles: string[], cls: string): HTMLElement | null {
  let first: HTMLElement | null = null;
  const wanted = needles.map(normalize).filter(Boolean);
  for (const layer of root.querySelectorAll<HTMLElement>(`.${styles.textLayer}`)) {
    const spans = [...layer.querySelectorAll<HTMLElement>("span")].filter((s) => !s.children.length);
    let hay = " ";
    const at: Array<{ span: HTMLElement; start: number; end: number }> = [];
    for (const span of spans) {
      const t = normalize(span.textContent ?? "");
      if (!t) continue;
      at.push({ span, start: hay.length, end: hay.length + t.length });
      hay += t + " ";
    }
    for (const n of wanted) {
      const i = indexOfToken(hay, n);
      if (i < 0) continue;
      for (const a of at) {
        if (a.end > i && a.start < i + n.length) {
          a.span.classList.add(cls);
          first ??= a.span;
        }
      }
      break;
    }
  }
  return first;
}
