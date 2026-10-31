import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, thumbUrl } from "../api";
import { DraftEditor, rankMatches } from "../components/DraftEditor";
import { Preview, STATUS_LABEL } from "../components/Preview";
import { cx } from "../cx";
import { useAppData } from "../data";
import ui from "../ui.module.css";
import styles from "./Inbox.module.css";
import type { DocumentDetail, DocumentSummary, Draft } from "../types";

const ACTIVE = ["queued", "ocr", "analyzing"];
/** Documents that can be filed: reviewed proposals, and failed ones filed by hand. */
const FILEABLE = ["inbox", "failed"];

/** Explicit mapping: a status value is never used as a class name itself. */
const STATUS_CLASS: Record<string, string | undefined> = {
  inbox: styles.statusReady,
  failed: styles.statusFailed,
  queued: ui.pulse,
  ocr: ui.pulse,
  analyzing: ui.pulse,
};

const same = (a: Draft, b: Draft) => JSON.stringify(a) === JSON.stringify(b);

/** Typing in a field shouldn't trigger list shortcuts. */
const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));

export function InboxPage() {
  const { id: routeId } = useParams();
  const navigate = useNavigate();
  const { catalog, objects, refresh, toast, status } = useAppData();
  const [items, setItems] = useState<DocumentSummary[]>([]);
  const [doc, setDoc] = useState<DocumentDetail | null>(null);
  const [draft, setDraftState] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [revising, setRevising] = useState(false);
  /**
   * Edits in progress, by document id. Switching documents keeps them, so
   * looking at another document never throws work away.
   */
  const edits = useRef(new Map<string, Draft>());
  const [, setEditCount] = useState(0);

  const baseline = (d: DocumentDetail): Draft => d.proposal?.draft ?? d.current;

  const setDraft = (next: Draft) => {
    setDraftState(next);
    if (!doc) return;
    if (same(next, baseline(doc))) edits.current.delete(doc.id);
    else edits.current.set(doc.id, next);
    setEditCount(edits.current.size);
  };

  const forget = (id: string) => {
    edits.current.delete(id);
    setEditCount(edits.current.size);
  };

  const dirty = !!doc && edits.current.has(doc.id);

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

  // Closing the tab with unfiled edits asks first.
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (edits.current.size) e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  const selected = items.find((i) => i.id === routeId) ?? (routeId ? undefined : items.find((i) => i.status === "inbox"));
  const selectedId = selected?.id ?? routeId;
  const selectedStatus = selected?.status;

  // (Re)load the detail when the selection changes or its processing finishes.
  useEffect(() => {
    if (!selectedId) { setDoc(null); setDraftState(null); return; }
    let cancelled = false;
    api.getDocument(selectedId).then((d) => {
      if (cancelled) return;
      setDoc(d);
      // Edits made earlier win over the stored proposal, unless processing replaced it.
      const kept = ACTIVE.includes(d.status) ? undefined : edits.current.get(d.id);
      if (!kept) edits.current.delete(d.id);
      setDraftState(structuredClone(kept ?? baseline(d)));
    }).catch((e) => toast(e.message, "error"));
    return () => { cancelled = true; };
  }, [selectedId, selectedStatus, toast]);

  // A half-written suggestion belongs to the document it was written for.
  useEffect(() => setFeedback(""), [selectedId]);

  /** Asks before an action that replaces the edits made to this document. */
  const discardOk = (what: string) => !dirty || confirm(`${what} replaces the changes you made to this document. Continue?`);

  /** Sends the draft as currently edited plus the suggestion; the AI's revision replaces the draft. */
  const revise = async () => {
    if (!doc || !draft || feedback.trim().length < 2) return;
    setRevising(true);
    try {
      const proposal = await api.revise(doc.id, draft, feedback.trim());
      setDoc({ ...doc, proposal, error: null });
      setDraftState(structuredClone(proposal.draft));
      forget(doc.id);
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

  const reviewable = items.filter((i) => FILEABLE.includes(i.status));

  /** Moves through the reviewable documents; wraps around. */
  const step = (dir: 1 | -1, skipSelf = false) => {
    const list = skipSelf ? reviewable.filter((i) => i.id !== selectedId) : reviewable;
    if (!list.length) return navigate("/");
    const idx = reviewable.findIndex((i) => i.id === selectedId);
    if (skipSelf) {
      // The current one is going away: take the one that was after it.
      const after = reviewable.slice(idx + 1).concat(reviewable.slice(0, Math.max(idx, 0))).find((i) => i.id !== selectedId);
      return navigate(`/inbox/${(after ?? list[0]).id}`);
    }
    const next = reviewable[(idx + dir + reviewable.length) % reviewable.length];
    navigate(`/inbox/${next.id}`);
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

  const canFile = !!doc && !!draft && FILEABLE.includes(doc.status) && !busy && !revising;

  const file = async () => {
    if (!doc || !draft || !canFile) return;
    const id = doc.id;
    if (await act(() => api.saveDocument(id, draft, true))) {
      forget(id);
      step(1, true);
      toast("Filed", "info", {
        label: "Undo",
        run: async () => {
          await api.unfileDocument(id);
          await Promise.all([loadList(), refresh()]);
          navigate(`/inbox/${id}`);
        },
      });
    }
  };

  const reanalyze = async (ocr: boolean) => {
    if (!doc || !discardOk(ocr ? "Redoing OCR" : "Re-running AI")) return;
    const id = doc.id;
    if (await act(() => api.reanalyze(id, ocr), ocr ? "Re-running OCR and AI…" : "Re-running AI…")) forget(id);
  };

  const remove = async () => {
    if (!doc) return;
    const id = doc.id;
    if (await act(() => api.deleteDocument(id))) {
      forget(id);
      step(1, true);
      toast("Moved to the trash", "info", {
        label: "Undo",
        run: async () => {
          await api.restoreDocument(id);
          await Promise.all([loadList(), refresh()]);
          navigate(`/inbox/${id}`);
        },
      });
    }
  };

  // Keyboard: J/K move through the inbox, Ctrl/⌘+Enter files.
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void file();
      return;
    }
    if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "j") step(1);
    else if (e.key === "k") step(-1);
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  /** Documents ticked in the list, to file in one go. */
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [batch, setBatch] = useState<{ done: number; total: number } | null>(null);
  const readyIds = items.filter((i) => i.status === "inbox" && i.proposed).map((i) => i.id);

  /**
   * Files the ticked documents one after another, each with its proposal (or
   * the edits made to it). One at a time, and documents that only link to or
   * update existing objects go first: a registration that adds a car's plate
   * then lets a bill that mentions only the plate find the car, instead of
   * creating it again. A document that would still create an object looking
   * like one you have is left in the inbox for a person to decide.
   */
  const fileSelected = async () => {
    const ids = readyIds.filter((id) => picked.has(id));
    const filed: string[] = [];
    const failed: string[] = [];
    const skipped: string[] = [];
    setBatch({ done: 0, total: ids.length });
    const drafts = await Promise.all(ids.map(async (id) => {
      const d = await api.getDocument(id).catch(() => null);
      return { id, draft: d ? edits.current.get(id) ?? d.proposal?.draft ?? d.current : null };
    }));
    drafts.sort((a, b) => (a.draft?.newObjects.length ?? 0) - (b.draft?.newObjects.length ?? 0));
    const titleOf = (id: string) => items.find((i) => i.id === id)?.proposed?.title ?? "A document";
    for (const { id, draft: first } of drafts) {
      try {
        if (!first) throw new Error("couldn't load it");
        let draft = first;
        if (draft.newObjects.length) {
          // Objects filed earlier in this batch may be the ones it proposes: check again.
          const fresh = edits.current.has(id) ? draft : (await api.getDocument(id)).proposal?.draft ?? draft;
          const existing = await api.objects();
          draft = fresh;
          const lookalike = draft.newObjects.map((o) => rankMatches(o, existing).likely[0]).find(Boolean);
          if (lookalike) {
            skipped.push(`${titleOf(id)} (looks like “${lookalike.title}”)`);
            continue;
          }
        }
        await api.saveDocument(id, draft, true);
        forget(id);
        filed.push(id);
      } catch (e) {
        failed.push(`${titleOf(id)}: ${(e as Error).message}`);
      } finally {
        setBatch({ done: filed.length + failed.length + skipped.length, total: ids.length });
      }
    }
    setBatch(null);
    setPicked(new Set());
    await Promise.all([loadList(), refresh()]);
    if (filed.includes(selectedId ?? "")) navigate("/");
    failed.forEach((f) => toast(f, "error"));
    if (skipped.length) toast(`Left in the inbox to check: ${skipped.join("; ")}`);
    if (filed.length) {
      toast(`Filed ${filed.length} document${filed.length > 1 ? "s" : ""}`, "info", {
        label: "Undo",
        run: async () => {
          for (const id of filed) await api.unfileDocument(id);
          await Promise.all([loadList(), refresh()]);
        },
      });
    }
  };

  const color = (key: string) => catalog.find((c) => c.key === key)?.color;
  // Components proposed but not created yet aren't in the catalog: "insurance_policy" -> "Insurance policy".
  const name = (key: string) => catalog.find((c) => c.key === key)?.name ?? key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, " ");

  return (
    <div className={cx(styles.page, routeId && styles.pageOpen)}>
      <aside className={styles.list}>
        {(picked.size > 0 || batch) && (
          <div className={styles.batchBar}>
            {batch ? (
              <span className={ui.small}>Filing {batch.done} of {batch.total}…</span>
            ) : (
              <>
                <button className={cx(ui.primary, ui.compact)} onClick={fileSelected}>File {picked.size} as proposed</button>
                <button className={cx(ui.link, ui.small)} onClick={() => setPicked(new Set())}>Clear</button>
              </>
            )}
          </div>
        )}
        {readyIds.length > 1 && picked.size === 0 && !batch && (
          <div className={styles.batchHint}>
            <button className={cx(ui.link, ui.small)} onClick={() => setPicked(new Set(readyIds))}>Select all {readyIds.length} ready</button>
          </div>
        )}
        {items.length === 0 && <p className={cx(ui.muted, ui.pad)}>Inbox is empty. Drop files anywhere to add documents.</p>}
        {items.map((i) => {
          const p = i.proposed;
          return (
            <div key={i.id} className={styles.itemRow}>
            {i.status === "inbox" && i.proposed && (
              <input
                type="checkbox"
                className={styles.pick}
                aria-label={`Select ${p?.title || i.title}`}
                checked={picked.has(i.id)}
                disabled={batch !== null}
                onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(i.id); else n.delete(i.id); return n; })}
              />
            )}
            <button className={cx(styles.item, i.id === selectedId && styles.itemActive)} onClick={() => navigate(`/inbox/${i.id}`)}>
              {i.hasThumb ? <img className={styles.thumb} src={thumbUrl(i.id)} alt="" /> : <div className={ui.thumbPlaceholder}>{fileKind(i.mimeType)}</div>}
              <div className={styles.itemBody}>
                <div className={styles.title}>{p?.title || i.title}</div>
                {p && (
                  <div className={cx(ui.small, ui.muted)}>
                    {p.documentDate ?? "no date"}
                    {p.title && p.title !== i.title && <> · {i.originalFilename}</>}
                  </div>
                )}
                {!!p?.components.length && (
                  <div className={cx(ui.badges, styles.itemBadges)}>
                    {p.components.map((k, n) => <span key={n} className={ui.badge} style={{ background: color(k) }}>{name(k)}</span>)}
                  </div>
                )}
                <div className={cx(styles.status, STATUS_CLASS[i.status])}>
                  {i.status === "queued" && i.error ? "Failed, retrying soon" : STATUS_LABEL[i.status]}
                  {edits.current.has(i.id) && <span className={styles.edited}> · edited</span>}
                </div>
              </div>
            </button>
            </div>
          );
        })}
      </aside>

      {doc && draft ? (
        <>
          <div className={styles.back}>
            <button className={ui.link} onClick={() => navigate("/")}>‹ Inbox</button>
            <span className={cx(ui.small, ui.muted)}>{doc.originalFilename}</span>
          </div>
          <section className={styles.preview}><Preview doc={doc} /></section>
          <section className={styles.editor}>
            {ACTIVE.includes(doc.status) ? (
              <>
                <p className={ui.muted}>{doc.status === "queued" && doc.error ? "Failed, retrying soon" : STATUS_LABEL[doc.status]}</p>
                {doc.error && <div className={cx(ui.alert, ui.warn)}>{doc.error}</div>}
              </>
            ) : (
              <>
                {doc.status === "failed" && (
                  <div className={cx(ui.alert, ui.error)}>
                    <p className={styles.alertText}>Processing failed: {doc.error}</p>
                    <p className={cx(styles.alertText, ui.small)}>You can still fill in the details and file it by hand, or try again.</p>
                    <div className={styles.alertActions}>
                      <button className={ui.compact} disabled={busy} onClick={() => reanalyze(true)}>Try again</button>
                    </div>
                  </div>
                )}
                {doc.status === "inbox" && doc.error && (
                  <div className={cx(ui.alert, ui.warn)}>
                    <p className={styles.alertText}>{doc.error}</p>
                    {status?.ai && !doc.proposal && (
                      <div className={styles.alertActions}>
                        <button className={ui.compact} disabled={busy} onClick={() => reanalyze(false)}>Run AI now</button>
                      </div>
                    )}
                  </div>
                )}
                {(doc.proposal || (status?.ai && doc.status === "inbox")) && (
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
                          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) { e.preventDefault(); void revise(); } }}
                          placeholder={doc.proposal ? "Suggest a change, e.g. “use an amount and a billing frequency instead of an annual amount”" : "Tell the AI how to file this document"}
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
                  <DraftEditor draft={draft} onChange={setDraft} catalog={catalog} objects={objects} showDate selfId={doc.id} onSameAs={sameAs} allowNewObjects />
                </fieldset>
                <div className={styles.actionBar}>
                  <button className={ui.primary} disabled={!canFile} onClick={file} title="Ctrl/⌘ + Enter">
                    {draft.newComponents.length || draft.newObjects.length ? "Create & file" : "File document"}
                  </button>
                  <button
                    disabled={busy || !dirty}
                    title="Go back to the AI's proposal"
                    onClick={() => { if (discardOk("Resetting")) { setDraftState(structuredClone(baseline(doc))); forget(doc.id); } }}
                  >
                    Reset
                  </button>
                  {dirty && <span className={cx(ui.small, ui.muted)}>Edited</span>}
                  <span className={ui.spacer} />
                  <span className={cx(ui.small, ui.muted, styles.keysHint)}>J / K to move</span>
                  <details className={styles.more}>
                    <summary className={ui.button} aria-label="More actions">⋯</summary>
                    <div className={styles.menu}>
                      {status?.ai && <button disabled={busy} onClick={() => reanalyze(false)}>Re-run AI</button>}
                      <button disabled={busy} onClick={() => reanalyze(true)}>Redo OCR</button>
                      <button className={ui.danger} disabled={busy} onClick={remove}>Move to trash</button>
                    </div>
                  </details>
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

/** A short label for a file type: "PDF", "PNG", "TXT". */
function fileKind(mime: string): string {
  const sub = mime.split("/")[1] ?? "";
  return { plain: "txt", markdown: "md", jpeg: "jpg" }[sub] ?? sub.slice(0, 4);
}
