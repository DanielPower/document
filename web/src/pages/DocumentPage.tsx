import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, fileUrl } from "../api";
import { DraftEditor } from "../components/DraftEditor";
import { DraftView } from "../components/DraftView";
import { Preview, STATUS_LABEL, TextPreview } from "../components/Preview";
import { cx } from "../cx";
import { useAppData } from "../data";
import type { DocumentDetail, Draft } from "../types";
import ui from "../ui.module.css";
import styles from "./DocumentPage.module.css";

export function DocumentPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { catalog, objects, refresh, toast } = useAppData();
  const [doc, setDoc] = useState<DocumentDetail | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [tab, setTab] = useState<"preview" | "text">("preview");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);

  const load = async () => {
    const d = await api.getDocument(id!);
    setDoc(d);
    setDraft(structuredClone(d.current));
  };
  useEffect(() => { setEditing(false); load().catch((e) => toast(e.message, "error")); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!doc || !draft) return <div className={cx(ui.page, ui.muted)}>Loading…</div>;

  const sameAs = async (tempId: string, objectId: string) => {
    try {
      const r = await api.reconcile(draft, { [tempId]: objectId });
      setDraft(r.draft);
      r.notes.forEach((n) => toast(n));
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await fn();
      if (done) toast(done);
      return true;
    } catch (e) {
      toast((e as Error).message, "error");
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={cx(styles.page, doc.mimeType.startsWith("text/") && styles.textDoc)}>
      <section className={styles.left}>
        <div className={styles.tabs}>
          <button className={cx(ui.compact, tab === "preview" && styles.tabOn)} onClick={() => setTab("preview")}>Page</button>
          <button className={cx(ui.compact, tab === "text" && styles.tabOn)} onClick={() => setTab("text")}>Text</button>
          <span className={ui.spacer} />
          <a href={fileUrl(doc.id, "original", true)}>Original</a>
          {doc.hasArchive && <a href={fileUrl(doc.id, "archive", true)}>Searchable PDF</a>}
        </div>
        {tab === "preview" ? <Preview doc={doc} /> : <TextPreview text={doc.content || "(no text)"} />}
      </section>
      <section className={styles.right}>
        <div className={cx(ui.muted, ui.small)}>
          {doc.originalFilename} · {STATUS_LABEL[doc.status]} · added {doc.addedAt.slice(0, 10)}
          {doc.status === "inbox" && <> · <Link to={`/inbox/${doc.id}`}>review in inbox</Link></>}
        </div>
        {editing ? (
          <>
            <DraftEditor draft={draft} onChange={setDraft} catalog={catalog} objects={objects} showDate selfId={doc.id} onSameAs={sameAs} />
            <div className={ui.actions}>
              <button
                className={ui.primary}
                disabled={busy}
                onClick={async () => {
                  if (!(await act(() => api.saveDocument(doc.id, draft, false), "Saved"))) return;
                  await Promise.all([refresh(), load()]);
                  setEditing(false);
                }}
              >
                Save
              </button>
              <button disabled={busy} onClick={() => { setDraft(structuredClone(doc.current)); setEditing(false); }}>Cancel</button>
            </div>
          </>
        ) : (
          <>
            <div className={styles.head}>
              <div className={ui.grow}>
                <h2 className={styles.title}>{doc.current.title}</h2>
                <div className={cx(ui.muted, ui.small)}>{doc.current.documentDate ?? "No date"}</div>
              </div>
              <button className={ui.compact} onClick={() => setEditing(true)}>Edit</button>
              <details className={ui.menuWrap}>
                <summary className={cx(ui.button, ui.compact, ui.ghost)} aria-label="More actions">⋯</summary>
                <div className={ui.menu}>
                  <button
                    disabled={busy}
                    title="Send it back to the inbox with a fresh AI proposal"
                    onClick={async () => { if (await act(() => api.reanalyze(doc.id), "Sent to inbox for re-analysis")) navigate(`/inbox/${doc.id}`); }}
                  >
                    Re-analyze
                  </button>
                  <button
                    className={ui.danger}
                    disabled={busy}
                    onClick={async () => {
                      if (!(await act(() => api.deleteDocument(doc.id)))) return;
                      navigate("/documents");
                      toast("Moved to the trash", "info", {
                        label: "Undo",
                        run: async () => { await api.restoreDocument(doc.id); await refresh(); navigate(`/documents/${doc.id}`); },
                      });
                    }}
                  >
                    Move to trash
                  </button>
                </div>
              </details>
            </div>
            <DraftView components={doc.current.components} catalog={catalog} objects={objects} />
          </>
        )}
      </section>
    </div>
  );
}
