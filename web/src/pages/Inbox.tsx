import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, thumbUrl } from "../api";
import { DraftEditor } from "../components/DraftEditor";
import { Preview, STATUS_LABEL } from "../components/Preview";
import { useAppData } from "../data";
import type { DocumentDetail, DocumentSummary, Draft } from "../types";

const ACTIVE = ["queued", "ocr", "analyzing"];

export function InboxPage() {
  const { id: routeId } = useParams();
  const navigate = useNavigate();
  const { catalog, objects, refresh, toast } = useAppData();
  const [items, setItems] = useState<DocumentSummary[]>([]);
  const [doc, setDoc] = useState<DocumentDetail | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);

  const loadList = useCallback(async () => {
    const res = await api.searchDocuments({ status: ["inbox", "failed", ...ACTIVE], sort: "added", limit: 200 });
    setItems(res.items);
    return res.items;
  }, []);

  // Poll while something is being processed.
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const list = await loadList();
        if (!stop) timer = setTimeout(tick, list.some((i) => ACTIVE.includes(i.status)) ? 2500 : 15000);
      } catch (e) {
        toast((e as Error).message, "error");
      }
    };
    void tick();
    return () => { stop = true; clearTimeout(timer); };
  }, [loadList, toast]);

  const selected = items.find((i) => i.id === routeId) ?? (routeId ? undefined : items.find((i) => i.status === "inbox"));
  const selectedId = selected?.id ?? routeId;
  const selectedStatus = selected?.status;

  // (Re)load the detail when the selection changes or its processing finishes.
  useEffect(() => {
    if (!selectedId) { setDoc(null); setDraft(null); return; }
    let cancelled = false;
    api.getDocument(selectedId).then((d) => {
      if (cancelled) return;
      setDoc(d);
      setDraft(structuredClone(d.proposal?.draft ?? d.current));
    }).catch((e) => toast(e.message, "error"));
    return () => { cancelled = true; };
  }, [selectedId, selectedStatus, toast]);

  const next = () => {
    const idx = items.findIndex((i) => i.id === selectedId);
    const after = items.slice(idx + 1).concat(items.slice(0, idx)).find((i) => i.status === "inbox" && i.id !== selectedId);
    navigate(after ? `/inbox/${after.id}` : "/");
  };

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await fn();
      if (done) toast(done);
      await Promise.all([loadList(), refresh()]);
      return true;
    } catch (e) {
      toast((e as Error).message, "error");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const file = async () => {
    if (!doc || !draft) return;
    if (await act(() => api.saveDocument(doc.id, draft, true), "Filed")) next();
  };

  return (
    <div className="inbox">
      <aside className="inbox-list">
        {items.length === 0 && <p className="muted pad">Inbox is empty. Drop files anywhere to add documents.</p>}
        {items.map((i) => (
          <button key={i.id} className={`inbox-item ${i.id === selectedId ? "active" : ""} ${i.status}`} onClick={() => navigate(`/inbox/${i.id}`)}>
            {i.hasThumb ? <img src={thumbUrl(i.id)} alt="" /> : <div className="thumb-ph">{i.mimeType.split("/")[1]}</div>}
            <div>
              <div className="title">{i.title}</div>
              <div className={`status ${i.status}`}>{STATUS_LABEL[i.status]}</div>
            </div>
          </button>
        ))}
      </aside>

      {doc && draft ? (
        <>
          <section className="inbox-preview"><Preview doc={doc} /></section>
          <section className="inbox-editor">
            {ACTIVE.includes(doc.status) ? (
              <p className="muted">{STATUS_LABEL[doc.status]}</p>
            ) : (
              <>
                {doc.status === "failed" && <div className="alert error">Processing failed: {doc.error}</div>}
                {doc.status === "inbox" && doc.error && <div className="alert warn">{doc.error}</div>}
                {doc.proposal && (
                  <div className="ai-note">
                    <div className="ai-note-head">AI proposal <span className="muted small">({doc.proposal.model})</span></div>
                    <p>{doc.proposal.reasoning}</p>
                    {doc.proposal.warnings.length > 0 && (
                      <details>
                        <summary className="small">{doc.proposal.warnings.length} item(s) dropped while checking the proposal</summary>
                        <ul className="small">{doc.proposal.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
                      </details>
                    )}
                  </div>
                )}
                <DraftEditor draft={draft} onChange={setDraft} catalog={catalog} objects={objects} showDate selfId={doc.id} />
                <div className="actions">
                  <button className="primary" disabled={busy || doc.status !== "inbox"} onClick={file}>
                    {draft.newComponents.length || draft.newObjects.length ? "Create & file" : "File document"}
                  </button>
                  <button disabled={busy} onClick={() => setDraft(structuredClone(doc.proposal?.draft ?? doc.current))}>Reset</button>
                  <span className="spacer" />
                  <button disabled={busy} onClick={() => act(() => api.reanalyze(doc.id), "Re-running AI…")}>Re-run AI</button>
                  <button disabled={busy} onClick={() => act(() => api.reanalyze(doc.id, true), "Re-running OCR and AI…")}>Redo OCR</button>
                  <button
                    className="danger"
                    disabled={busy}
                    onClick={async () => { if (confirm("Delete this document and its files?") && (await act(() => api.deleteDocument(doc.id), "Deleted"))) next(); }}
                  >
                    Delete
                  </button>
                </div>
              </>
            )}
          </section>
        </>
      ) : (
        <section className="inbox-preview empty muted">{items.length ? "Select a document" : ""}</section>
      )}
    </div>
  );
}
