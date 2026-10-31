import { fileUrl } from "../api";
import type { DocumentDetail } from "../types";

export function Preview({ doc }: { doc: DocumentDetail }) {
  if (doc.hasArchive) return <iframe className="preview" src={fileUrl(doc.id)} title={doc.title} />;
  if (doc.mimeType.startsWith("text/")) return <pre className="preview text">{doc.content}</pre>;
  if (doc.mimeType.startsWith("image/")) return <img className="preview" src={fileUrl(doc.id, "original")} alt={doc.title} />;
  return <div className="preview empty">No preview yet</div>;
}

export const STATUS_LABEL: Record<string, string> = {
  queued: "Queued",
  ocr: "Reading text…",
  analyzing: "AI is analyzing…",
  inbox: "Ready for review",
  filed: "Filed",
  failed: "Failed",
};
