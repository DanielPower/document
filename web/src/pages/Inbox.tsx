import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, thumbUrl } from "../api";
import { DraftEditor } from "../components/DraftEditor";
import { Preview, STATUS_LABEL } from "../components/Preview";
import { cx } from "../cx";
import { useAppData } from "../data";
import ui from "../ui.module.css";
import styles from "./Inbox.module.css";
import type { DocumentDetail, DocumentSummary, Draft } from "../types";

const ACTIVE = ["queued", "ocr", "analyzing"];

/** Explicit mapping: a status value is never used as a class name itself. */
const STATUS_CLASS: Record<string, string | undefined> = {
  inbox: styles.statusReady,
  failed: styles.statusFailed,
  queued: ui.pulse,
  ocr: ui.pulse,
  analyzing: ui.pulse,
};

export function InboxPage() {
  const { id: routeId } = useParams();
  const navigate = useNavigate();
  const { catalog, objects, refresh, toast, status } = useAppData();
  const [items, setItems] = useState<DocumentSummary[]>([]);
  const [doc, setDoc] = useState<DocumentDetail | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [revising, setRevising] = useState(false);

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

  // A half-written suggestion belongs to the document it was written for.
  useEffect(() => setFeedback(""), [selectedId]);

  /** Sends the draft as currently edited plus the suggestion; the AI's revision replaces the draft. */
  const revise = async () => {
    if (!doc || !draft || feedback.trim().length < 2) return;
    setRevising(true);
    try {
      const proposal = await api.revise(doc.id, draft, feedback.trim());
      setDoc({ ...doc, proposal, error: null });
      setDraft(structuredClone(proposal.draft));
      setFeedback("");
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setRevising(false);
    }
  };

  /** The owner picked an existing object for a proposed new one; the server merges the details. */
  const sameAs = async (tempId: string, objectId: string) => {
    if (!draft) return;
    try {
      const r = await api.reconcile(draft, { [tempId]: objectId });
      setDraft(r.draft);
      r.notes.forEach((n) => toast(n));
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

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
    <div className={styles.page}>
      <aside className={styles.list}>
        {items.length === 0 && <p className={cx(ui.muted, ui.pad)}>Inbox is empty. Drop files anywhere to add documents.</p>}
        {items.map((i) => (
          <button key={i.id} className={cx(styles.item, i.id === selectedId && styles.itemActive)} onClick={() => navigate(`/inbox/${i.id}`)}>
            {i.hasThumb ? <img className={styles.thumb} src={thumbUrl(i.id)} alt="" /> : <div className={ui.thumbPlaceholder}>{i.mimeType.split("/")[1]}</div>}
            <div>
              <div className={styles.title}>{i.title}</div>
              <div className={cx(styles.status, STATUS_CLASS[i.status])}>{i.status === "queued" && i.error ? "Failed, retrying soon" : STATUS_LABEL[i.status]}</div>
            </div>
          </button>
        ))}
      </aside>

      {doc && draft ? (
        <>
          <section className={styles.preview}><Preview doc={doc} /></section>
          <section className={styles.editor}>
            {ACTIVE.includes(doc.status) ? (
              <>
                <p className={ui.muted}>{doc.status === "queued" && doc.error ? "Failed, retrying soon" : STATUS_LABEL[doc.status]}</p>
                {doc.error && <div className={cx(ui.alert, ui.warn)}>{doc.error}</div>}
              </>
            ) : (
              <>
                {doc.status === "failed" && <div className={cx(ui.alert, ui.error)}>Processing failed: {doc.error}</div>}
                {doc.status === "inbox" && doc.error && <div className={cx(ui.alert, ui.warn)}>{doc.error}</div>}
                {(doc.proposal || status?.ai) && (
                  <div className={ui.aiNote}>
                    {doc.proposal && (
                      <>
                        <div className={ui.aiNoteHead}>AI proposal <span className={cx(ui.muted, ui.small)}>({doc.proposal.model})</span></div>
                        <p>{doc.proposal.reasoning}</p>
                        {!!doc.proposal.matched?.length && (
                          <ul className={cx(ui.small, styles.feedbackList)}>
                            {doc.proposal.matched.map((m, i) => <li key={i}>{m}</li>)}
                          </ul>
                        )}
                        {doc.proposal.warnings.length > 0 && (
                          <details>
                            <summary className={ui.small}>{doc.proposal.warnings.length} item(s) dropped while checking the proposal</summary>
                            <ul className={ui.small}>{doc.proposal.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
                          </details>
                        )}
                      </>
                    )}
                    {status?.ai && doc.status === "inbox" && (
                      <form className={styles.revise} onSubmit={(e) => { e.preventDefault(); void revise(); }}>
                        {!!doc.proposal?.feedback?.length && (
                          <ul className={cx(ui.small, ui.muted, styles.feedbackList)}>
                            {doc.proposal.feedback.map((f, i) => <li key={i}>You asked: {f}</li>)}
                          </ul>
                        )}
                        <textarea
                          rows={2}
                          value={feedback}
                          disabled={revising}
                          onChange={(e) => setFeedback(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void revise(); } }}
                          placeholder={doc.proposal ? "Suggest a change, e.g. \u201cuse an amount and a billing frequency instead of an annual amount\u201d" : "Tell the AI how to file this document"}
                        />
                        <div className={styles.reviseActions}>
                          <span className={cx(ui.small, ui.muted)}>Your edits below are kept unless you ask to change them.</span>
                          <button disabled={revising || feedback.trim().length < 2}>{revising ? "Revising…" : "Revise"}</button>
                        </div>
                      </form>
                    )}
                  </div>
                )}
                <fieldset className={styles.editorFieldset} disabled={revising}>
                  <DraftEditor draft={draft} onChange={setDraft} catalog={catalog} objects={objects} showDate selfId={doc.id} onSameAs={sameAs} />
                </fieldset>
                <div className={ui.actions}>
                  <button className={ui.primary} disabled={busy || revising || doc.status !== "inbox"} onClick={file}>
                    {draft.newComponents.length || draft.newObjects.length ? "Create & file" : "File document"}
                  </button>
                  <button disabled={busy} onClick={() => setDraft(structuredClone(doc.proposal?.draft ?? doc.current))}>Reset</button>
                  <span className={ui.spacer} />
                  <button disabled={busy} onClick={() => act(() => api.reanalyze(doc.id), "Re-running AI…")}>Re-run AI</button>
                  <button disabled={busy} onClick={() => act(() => api.reanalyze(doc.id, true), "Re-running OCR and AI…")}>Redo OCR</button>
                  <button
                    className={ui.danger}
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
        <section className={cx(styles.preview, styles.previewEmpty)}>{items.length ? "Select a document" : ""}</section>
      )}
    </div>
  );
}
