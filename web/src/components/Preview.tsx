import { lazy, Suspense } from "react";
import { fileUrl } from "../api";
import { cx } from "../cx";
import type { DocumentDetail } from "../types";
import styles from "./Preview.module.css";

/** PDF.js is large, so it loads only when a PDF is shown. */
const PdfViewer = lazy(() => import("./PdfViewer"));

export function Preview({ doc }: { doc: DocumentDetail }) {
  if (doc.hasArchive) {
    return (
      <Suspense fallback={<div className={styles.preview} />}>
        <PdfViewer url={fileUrl(doc.id)} />
      </Suspense>
    );
  }
  if (doc.mimeType.startsWith("text/")) return <pre className={cx(styles.preview, styles.text)}>{doc.content}</pre>;
  if (doc.mimeType.startsWith("image/")) return <img className={styles.preview} src={fileUrl(doc.id, "original")} alt={doc.title} />;
  return <div className={styles.preview}>No preview yet</div>;
}

/** Plain text shown in the same frame as a document preview. */
export function TextPreview({ text }: { text: string }) {
  return <pre className={cx(styles.preview, styles.text)}>{text}</pre>;
}

export const STATUS_LABEL: Record<string, string> = {
  queued: "Queued",
  ocr: "Reading text…",
  analyzing: "AI is analyzing…",
  inbox: "Ready for review",
  filed: "Filed",
  failed: "Failed",
};
