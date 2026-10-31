import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, fileUrl } from "../api";
import { DraftEditor } from "../components/DraftEditor";
import { Preview, STATUS_LABEL } from "../components/Preview";
import { useAppData } from "../data";
import type { DocumentDetail, Draft } from "../types";

export function DocumentPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { catalog, objects, refresh, toast } = useAppData();
  const [doc, setDoc] = useState<DocumentDetail | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [tab, setTab] = useState<"preview" | "text">("preview");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const d = await api.getDocument(id!);
    setDoc(d);
    setDraft(structuredClone(d.current));
  };
  useEffect(() => { load().catch((e) => toast(e.message, "error")); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!doc || !draft) return <div className="page muted">Loading…</div>;

  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await fn();
      toast(done);
      return true;
    } catch (e) {
      toast((e as Error).message, "error");
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="doc-page">
      <section className="doc-left">
        <div className="tabs">
          <button className={tab === "preview" ? "on" : ""} onClick={() => setTab("preview")}>Preview</button>
          <button className={tab === "text" ? "on" : ""} onClick={() => setTab("text")}>Text</button>
          <span className="spacer" />
          <a href={fileUrl(doc.id, "original", true)}>Original</a>
          {doc.hasArchive && <a href={fileUrl(doc.id, "archive", true)}>Searchable PDF</a>}
        </div>
        {tab === "preview" ? <Preview doc={doc} /> : <pre className="preview text">{doc.content || "(no text)"}</pre>}
      </section>
      <section className="doc-right">
        <div className="muted small">
          {doc.originalFilename} · {STATUS_LABEL[doc.status]} · added {new Date(doc.addedAt).toLocaleDateString()}
          {doc.status === "inbox" && <> · <Link to={`/inbox/${doc.id}`}>review in inbox</Link></>}
        </div>
        <DraftEditor draft={draft} onChange={setDraft} catalog={catalog} objects={objects} showDate selfId={doc.id} />
        <div className="actions">
          <button
            className="primary"
            disabled={busy}
            onClick={async () => { if (await act(() => api.saveDocument(doc.id, draft, false), "Saved")) { await refresh(); await load(); } }}
          >
            Save
          </button>
          <button disabled={busy} onClick={() => setDraft(structuredClone(doc.current))}>Revert</button>
          <span className="spacer" />
          <button
            disabled={busy}
            title="Send it back to the inbox with a fresh AI proposal"
            onClick={async () => { if (await act(() => api.reanalyze(doc.id), "Sent to inbox for re-analysis")) navigate(`/inbox/${doc.id}`); }}
          >
            Re-analyze
          </button>
          <button
            className="danger"
            disabled={busy}
            onClick={async () => { if (confirm("Delete this document and its files?") && (await act(() => api.deleteDocument(doc.id), "Deleted"))) navigate("/documents"); }}
          >
            Delete
          </button>
        </div>
      </section>
    </div>
  );
}
