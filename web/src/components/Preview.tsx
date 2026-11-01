import { lazy, Suspense, useEffect, useMemo, useRef } from "react";
import { fileUrl } from "../api";
import { cx } from "../cx";
import type { DocumentDetail } from "../types";
import styles from "./Preview.module.css";

/** PDF.js is large, so it loads only when a PDF is shown. */
const PdfViewer = lazy(() => import("./PdfViewer"));

/** Shows a document; `highlight` marks where one of those strings appears (PDFs and text files). */
export function Preview({ doc, highlight }: { doc: DocumentDetail; highlight?: string[] | null }) {
  if (doc.hasArchive) {
    return (
      <Suspense fallback={<div className={styles.preview} />}>
        <PdfViewer url={fileUrl(doc.id)} highlight={highlight} />
      </Suspense>
    );
  }
  if (doc.mimeType.startsWith("text/")) return <TextPreview text={doc.content} highlight={highlight} />;
  if (doc.mimeType.startsWith("image/")) return <img className={styles.preview} src={fileUrl(doc.id, "original")} alt={doc.title} />;
  return <div className={cx(styles.preview, styles.empty)}>{doc.status === "failed" ? "No preview: processing failed" : "No preview yet"}</div>;
}

/** Plain text shown in the same frame as a document preview, with the first match of `highlight` marked. */
export function TextPreview({ text, highlight }: { text: string; highlight?: string[] | null }) {
  const box = useRef<HTMLPreElement>(null);
  const hit = useMemo(() => {
    for (const n of highlight ?? []) {
      const words = n.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      if (!words[0]) continue;
      const m = new RegExp(`(?<![\\p{L}\\p{N}])${words.join("\\s+")}(?![\\p{L}\\p{N}])`, "iu").exec(text);
      if (m) return { start: m.index, end: m.index + m[0].length };
    }
    return null;
  }, [text, highlight]);
  useEffect(() => { box.current?.querySelector("mark")?.scrollIntoView({ block: "nearest" }); }, [hit]);
  return (
    <pre ref={box} className={cx(styles.preview, styles.text)}>
      {hit ? <>{text.slice(0, hit.start)}<mark className={styles.hit}>{text.slice(hit.start, hit.end)}</mark>{text.slice(hit.end)}</> : text}
    </pre>
  );
}

export const STATUS_LABEL: Record<string, string> = {
  queued: "Queued",
  ocr: "Reading text…",
  analyzing: "AI is analyzing…",
  inbox: "Ready for review",
  filed: "Filed",
  failed: "Failed",
};
