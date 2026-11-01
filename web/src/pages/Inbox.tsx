import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { ComponentDots } from "../components/Chip";
import { defsFor, display, DraftEditor, rankMatches, type ValueMark } from "../components/DraftEditor";
import { DateInput, quietClass } from "../components/FieldInputs";
import { Icon } from "../components/Icon";
import { Preview, STATUS_LABEL } from "../components/Preview";
import { cx } from "../cx";
import { useAppData } from "../data";
import { ACTIVE, effectsOf, fileLabel, triage, type Group, type Triage } from "../inboxTriage";
import { provenance } from "../provenance";
import ui from "../ui.module.css";
import styles from "./Inbox.module.css";
import type { ComponentDef, DocumentDetail, DocumentSummary, Draft, DraftValue, ObjectDetail, ObjectSummary } from "../types";

/** Documents that can be filed: reviewed proposals, and failed ones filed by hand. */
const FILEABLE = ["inbox", "failed"];
const GROUPS: Array<{ id: Group; label: string }> = [
  { id: "needs", label: "Needs you" },
  { id: "ready", label: "Ready" },
  { id: "processing", label: "Processing" },
  { id: "failed", label: "Couldn’t read" },
];

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const empty = (v: unknown) => v === null || v === undefined || v === "";

/** Typing in a field shouldn't trigger list shortcuts. */
const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));

/** "2026-10-28" -> "Oct 28" this year, "2025-10-28" otherwise. */
function shortDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.getFullYear() === new Date().getFullYear() ? d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) : iso;
}

/** Values that changed between two drafts, by marker path ("c0.paid", "title", "date"), with the old value. */
function changedPaths(before: Draft, after: Draft): Map<string, DraftValue> {
  const out = new Map<string, DraftValue>();
  if (before.title !== after.title) out.set("title", before.title);
  if (before.documentDate !== after.documentDate) out.set("date", before.documentDate);
  after.components.forEach((c, i) => {
    const old = before.components[i]?.component === c.component ? before.components[i].values : {};
    for (const [k, v] of Object.entries(c.values)) if (!same(old[k] ?? null, v ?? null)) out.set(`c${i}.${k}`, old[k] ?? null);
  });
  return out;
}

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
  /** Strings to highlight in the preview: the value being pointed at. */
  const [locate, setLocate] = useState<string[] | null>(null);
  /** Phones: the preview opened full screen. */
  const [previewOpen, setPreviewOpen] = useState(false);
  /** Phones: the change request sheet. */
  const [asking, setAsking] = useState(false);
  /**
   * Edits in progress, by document id. Switching documents keeps them, so
   * looking at another document never throws work away.
   */
  const edits = useRef(new Map<string, Draft>());
  /** Values the AI's last revision changed, per document, with what they were. */
  const revised = useRef(new Map<string, Map<string, DraftValue>>());
  /** "No, create a new one" answers to look-alike questions, as "docId:tempId". */
  const dismissed = useRef(new Set<string>());
  const [, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);

  const baseline = (d: DocumentDetail): Draft => d.proposal?.draft ?? d.current;

  const setDraft = (next: Draft) => {
    setDraftState(next);
    if (!doc) return;
    if (same(next, baseline(doc))) edits.current.delete(doc.id);
    else edits.current.set(doc.id, next);
    bump();
  };

  const forget = (id: string) => {
    edits.current.delete(id);
    revised.current.delete(id);
    bump();
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

  /** Each document's group, questions, key values and effects, from its edits or its proposal. */
  const triaged = useMemo(() => {
    const m = new Map<string, Triage>();
    for (const i of items) {
      const d = edits.current.get(i.id) ?? i.proposed?.draft;
      m.set(i.id, triage(i, d, catalog, objects, (t) => dismissed.current.has(`${i.id}:${t}`)));
    }
    return m;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, catalog, objects, draft]);

  const grouped = useMemo(() => GROUPS.map((g) => ({ ...g, items: items.filter((i) => triaged.get(i.id)?.group === g.id) })), [items, triaged]);
  /** Review order: what needs you, then what's ready, then what couldn't be read. */
  const reviewable = useMemo(
    () => ["needs", "ready", "failed"].flatMap((g) => grouped.find((x) => x.id === g)!.items).filter((i) => FILEABLE.includes(i.status)),
    [grouped],
  );

  const selected = items.find((i) => i.id === routeId) ?? (routeId ? undefined : reviewable[0]);
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

  // A half-written suggestion, a highlight and an open preview belong to the document they were for.
  useEffect(() => { setFeedback(""); setLocate(null); setPreviewOpen(false); setAsking(false); }, [selectedId]);

  /** Asks before an action that replaces the edits made to this document. */
  const discardOk = (what: string) => !dirty || confirm(`${what} replaces the changes you made to this document. Continue?`);

  /** Sends the draft as currently edited plus the suggestion; the AI's revision replaces the draft, and what it changed is marked. */
  const revise = async () => {
    if (!doc || !draft || feedback.trim().length < 2) return;
    setRevising(true);
    try {
      const before = draft;
      const proposal = await api.revise(doc.id, draft, feedback.trim());
      setDoc({ ...doc, proposal, error: null });
      setDraftState(structuredClone(proposal.draft));
      edits.current.delete(doc.id);
      revised.current.set(doc.id, changedPaths(before, proposal.draft));
      bump();
      setFeedback("");
      setAsking(false);
      const n = revised.current.get(doc.id)!.size;
      toast(n ? `The AI changed ${n} value${n === 1 ? "" : "s"}; they're marked “rev”.` : "The AI didn't change any values.");
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

  /** Documents ticked in the list, to file in one go. Only "Ready" ones can be ticked. */
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [batch, setBatch] = useState<{ done: number; total: number } | null>(null);
  const readyIds = grouped.find((g) => g.id === "ready")!.items.map((i) => i.id);
  // Drop ticks on documents that left "Ready" (filed elsewhere, or edited into needing a decision).
  useEffect(() => {
    if ([...picked].some((id) => !readyIds.includes(id))) setPicked(new Set([...picked].filter((id) => readyIds.includes(id))));
    if (!picked.size) setConfirming(false);
  }, [readyIds.join(), picked]); // eslint-disable-line react-hooks/exhaustive-deps

  const togglePick = (id: string, on: boolean) => {
    setPicked((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; });
    if (on) setConfirming(true);
  };

  /**
   * Files the ticked documents one after another, each with its proposal (or
   * the edits made to it). Documents that only link to or update existing
   * objects go first: a registration that adds a car's plate then lets a bill
   * that mentions only the plate find the car. A document whose proposal now
   * creates an object that looks like one you have is left for you to decide.
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
        let d = first;
        if (d.newObjects.length) {
          // Objects filed earlier in this batch may be the ones it proposes: check again.
          const fresh = edits.current.has(id) ? d : (await api.getDocument(id)).proposal?.draft ?? d;
          const existing = await api.objects();
          d = fresh;
          const lookalike = d.newObjects.map((o) => rankMatches(o, existing).likely[0]).find(Boolean);
          if (lookalike && !d.newObjects.every((o) => dismissed.current.has(`${id}:${o.tempId}`))) {
            skipped.push(`${titleOf(id)} (looks like “${lookalike.title}”)`);
            continue;
          }
        }
        await api.saveDocument(id, d, true);
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
    setConfirming(false);
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

  // ---- value markers -------------------------------------------------------
  const defs = useMemo(() => (draft ? defsFor(catalog, draft) : new Map()), [catalog, draft]);
  const markFor = (path: string): ValueMark | undefined => {
    if (!doc || !draft) return undefined;
    const base = baseline(doc);
    const rev = revised.current.get(doc.id);
    let field: Parameters<typeof provenance>[0] = { type: "date", options: {} };
    let value: DraftValue = null;
    let was: DraftValue = null;
    let wasKnown = false;
    if (path === "date") {
      value = draft.documentDate;
      was = base.documentDate;
      wasKnown = true;
    } else {
      const m = /^c(\d+)\.(.+)$/.exec(path);
      if (!m) return undefined;
      const c = draft.components[Number(m[1])];
      const f = c && defs.get(c.component)?.fields.find((x: { key: string }) => x.key === m[2]);
      if (!f) return undefined;
      field = f;
      value = c.values[m[2]] ?? null;
      const b = base.components[Number(m[1])];
      if (b?.component === c.component) { was = b.values[m[2]] ?? null; wasKnown = true; }
    }
    const show = (v: DraftValue) => (empty(v) ? "empty" : display(field, v, objects));
    if (wasKnown && !same(was ?? null, value ?? null)) return { kind: "you", note: `was ${show(was)}` };
    if (!wasKnown && dirty) return { kind: "you" };
    if (rev?.has(path)) return { kind: "revised", note: `was ${show(rev.get(path)!)}` };
    if (!doc.proposal) return undefined;
    const p = provenance(field, value, doc.content);
    return p.kind === "inferred" ? { kind: "inferred", note: field.type === "boolean" ? "judged, not read" : "not in the text" } : undefined;
  };

  const editCount = doc && draft ? changedPaths(baseline(doc), draft).size : 0;
  const position = selectedId ? reviewable.findIndex((i) => i.id === selectedId) : -1;
  const titleMark = doc && draft && revised.current.get(doc.id)?.has("title");
  const dateMark = markFor("date");
  const decisions = doc && draft && FILEABLE.includes(doc.status)
    ? draft.newObjects
      .map((o) => ({ o, best: rankMatches(o, objects).likely[0] }))
      .filter((x) => x.best && !dismissed.current.has(`${doc.id}:${x.o.tempId}`))
    : [];

  const pickedItems = items.filter((i) => picked.has(i.id));

  return (
    <div className={cx(styles.page, routeId && styles.pageOpen, confirming && picked.size > 0 && styles.pageConfirming)}>
      <aside className={styles.list}>
        {items.length === 0 && <p className={cx(ui.muted, ui.pad)}>Inbox is empty. Drop files anywhere to add documents.</p>}
        {grouped.filter((g) => g.items.length).map((g) => (
          <section key={g.id} aria-label={g.label}>
            <div className={cx(ui.groupHead, styles.groupHead)}>
              {g.label} <span className={styles.groupCount}>{g.items.length}</span>
              <span className={ui.spacer} />
              {g.id === "ready" && g.items.length > 0 && !batch && (
                picked.size ? (
                  <>
                    <button className={cx(ui.link, ui.small, styles.groupAction)} onClick={() => setPicked(new Set())}>Clear</button>
                    <button className={cx(ui.compact, ui.primary, styles.groupAction)} onClick={() => setConfirming(true)}>File {picked.size}…</button>
                  </>
                ) : (
                  <button className={cx(ui.compact, styles.groupAction)} onClick={() => { setPicked(new Set(readyIds)); setConfirming(true); }}>Select {g.items.length}</button>
                )
              )}
            </div>
            {g.items.map((i) => {
              const t = triaged.get(i.id)!;
              const p = i.proposed;
              const d = edits.current.get(i.id) ?? p?.draft;
              return (
                <div key={i.id} className={cx(styles.row, i.id === selectedId && !confirming && styles.rowActive)}>
                  {g.id === "ready" ? (
                    <input
                      type="checkbox"
                      className={styles.pick}
                      aria-label={`Select ${p?.title || i.title}`}
                      checked={picked.has(i.id)}
                      disabled={batch !== null}
                      onChange={(e) => togglePick(i.id, e.target.checked)}
                    />
                  ) : <span />}
                  <button className={styles.rowMain} onClick={() => { setConfirming(false); navigate(`/inbox/${i.id}`); }}>
                    <span className={styles.rowTitle}>{d?.title || p?.title || i.title}</span>
                    <span className={styles.rowDate}>{g.id === "processing" ? "now" : shortDate(d?.documentDate ?? i.documentDate)}</span>
                    {(t.who || t.amount || d?.components.length) ? (
                      <span className={styles.rowSub}>
                        {d && <ComponentDots keys={d.components.map((c) => c.component)} catalog={catalog} />}
                        {t.who && <span className={styles.ellipsis}>{t.who}</span>}
                        {t.who && t.amount && <span className={ui.muted}>·</span>}
                        {t.amount && <b className={styles.amount}>{t.amount}</b>}
                      </span>
                    ) : null}
                    <RowStatus doc={i} t={t} edited={edits.current.has(i.id)} />
                  </button>
                </div>
              );
            })}
          </section>
        ))}
      </aside>

      {confirming && picked.size > 0 ? (
        <BatchPanel
          items={pickedItems}
          drafts={(id) => edits.current.get(id) ?? items.find((i) => i.id === id)?.proposed?.draft}
          catalog={catalog}
          objects={objects}
          batch={batch}
          onCancel={() => setConfirming(false)}
          onFile={fileSelected}
          onRemove={(id) => togglePick(id, false)}
        />
      ) : doc && draft ? (
        <>
          <div className={styles.back}>
            <button className={cx(ui.link, styles.backLink)} onClick={() => navigate("/")}>‹ Inbox</button>
            <span className={ui.spacer} />
            {position >= 0 && <span className={cx(ui.small, ui.muted)}>{position + 1} of {reviewable.length}</span>}
            <button className={cx(ui.compact, styles.stepBtn)} onClick={() => step(-1)} aria-label="Previous document"><Icon name="up" size={16} /></button>
            <button className={cx(ui.compact, styles.stepBtn)} onClick={() => step(1)} aria-label="Next document"><Icon name="down" size={16} /></button>
          </div>
          <section className={cx(styles.preview, previewOpen && styles.previewOpen)}>
            <Preview doc={doc} highlight={locate} />
            <button className={styles.previewToggle} onClick={() => setPreviewOpen((v) => !v)}>
              {previewOpen ? <><Icon name="close" size={14} /> Close</> : <><Icon name="expand" size={14} /> View page</>}
            </button>
          </section>
          <section className={styles.editor} onMouseLeave={() => setLocate(null)}>
            {ACTIVE.includes(doc.status) ? (
              <div className={styles.editorBody}>
                <p className={cx(ui.muted, ui.pulse)}>{doc.status === "queued" && doc.error ? "Failed, retrying soon" : STATUS_LABEL[doc.status]}</p>
                {doc.error && <div className={cx(ui.alert, ui.warn)}>{doc.error}</div>}
              </div>
            ) : (
              <>
                <div className={styles.editorBody}>
                  <header className={styles.head}>
                    <input
                      className={cx(quietClass, styles.title, titleMark && styles.titleRevised)}
                      value={draft.title}
                      aria-label="Title"
                      placeholder="Title"
                      onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                    />
                    <div className={styles.meta}>
                      <span className={cx(styles.dateBox, dateMark?.kind === "inferred" && styles.dateInferred, dateMark?.kind === "you" && styles.dateYou)} title={dateMark?.note}>
                        <DateInput
                          quiet
                          value={draft.documentDate}
                          aria-label="Document date"
                          onChange={(v) => setDraft({ ...draft, documentDate: v })}
                          onFocus={() => setLocate(draft.documentDate ? [draft.documentDate] : null)}
                        />
                      </span>
                      <span>·</span>
                      <span>{doc.proposal ? <>Proposed by AI <span className={ui.muted}>({doc.proposal.model})</span></> : "No AI proposal"}</span>
                      <span className={styles.metaFile} title={doc.originalFilename}>· {doc.originalFilename}</span>
                    </div>
                  </header>

                  {doc.status === "failed" && (
                    <div className={cx(ui.alert, ui.error)}>
                      <p className={styles.alertText}>Couldn’t read this document: {doc.error}</p>
                      <p className={cx(styles.alertText, ui.small)}>Fill in the details by hand and file it, or try again.</p>
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

                  {doc.proposal && (
                    <div className={styles.why}>
                      <span className={ui.aiMark}>AI</span>
                      <div>
                        <p>{doc.proposal.reasoning}</p>
                        {!!doc.proposal.matched?.length && <p className={cx(ui.small, ui.muted)}>{doc.proposal.matched.join(" ")}</p>}
                        {doc.proposal.warnings.length > 0 && (
                          <details className={ui.small}>
                            <summary className={ui.muted}>{doc.proposal.warnings.length} item{doc.proposal.warnings.length === 1 ? "" : "s"} dropped while checking the proposal</summary>
                            <ul className={styles.plainList}>{doc.proposal.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
                          </details>
                        )}
                      </div>
                    </div>
                  )}

                  {decisions.map(({ o, best }) => (
                    <Decision
                      key={o.tempId}
                      proposed={o}
                      existing={best!}
                      catalog={catalog}
                      objects={objects}
                      onYes={() => sameAs(o.tempId, best!.id)}
                      onNo={() => { dismissed.current.add(`${doc.id}:${o.tempId}`); bump(); }}
                    />
                  ))}

                  <fieldset className={styles.editorFieldset} disabled={revising}>
                    <DraftEditor
                      review
                      draft={draft}
                      onChange={setDraft}
                      catalog={catalog}
                      objects={objects}
                      showDate
                      selfId={doc.id}
                      onSameAs={sameAs}
                      allowNewObjects
                      markFor={markFor}
                      onLocate={(n) => setLocate(n.length ? n : null)}
                    />
                  </fieldset>
                </div>

                <div className={styles.foot}>
                  {status?.ai && doc.status === "inbox" && (
                    <form className={cx(styles.revise, asking && styles.reviseOpen)} onSubmit={(e) => { e.preventDefault(); void revise(); }}>
                      {!!doc.proposal?.feedback?.length && (
                        <ul className={cx(ui.small, ui.muted, styles.plainList)}>
                          {doc.proposal.feedback.map((f, i) => <li key={i}>You asked: {f}</li>)}
                        </ul>
                      )}
                      <div className={styles.reviseRow}>
                        <span className={ui.aiMark}>AI</span>
                        <input
                          value={feedback}
                          disabled={revising}
                          onChange={(e) => setFeedback(e.target.value)}
                          placeholder={doc.proposal ? "Ask for a change, e.g. “it was paid by Visa”" : "Tell the AI how to file this document"}
                          aria-label="Ask the AI for a change"
                        />
                        <button className={ui.compact} disabled={revising || feedback.trim().length < 2}>{revising ? "Revising…" : "Revise"}</button>
                      </div>
                    </form>
                  )}
                  <div className={styles.fileRow}>
                    <button className={cx(ui.primary, styles.fileBtn)} disabled={!canFile} onClick={file} title="Ctrl/⌘ + Enter">
                      {fileLabel(draft)} <kbd className={styles.keysHint}>⌘↵</kbd>
                    </button>
                    {status?.ai && doc.status === "inbox" && (
                      <button className={styles.askBtn} onClick={() => setAsking((v) => !v)} aria-expanded={asking}>Ask AI</button>
                    )}
                    <button onClick={() => step(1)} title="Next document (J)">Skip <kbd className={styles.keysHint}>J</kbd></button>
                    <span className={ui.spacer} />
                    {editCount > 0 && (
                      <button
                        className={cx(ui.link, ui.small)}
                        disabled={busy}
                        title="Go back to the AI's proposal"
                        onClick={() => { if (discardOk("Resetting")) { setDraftState(structuredClone(baseline(doc))); forget(doc.id); } }}
                      >
                        {editCount} edit{editCount === 1 ? "" : "s"} · reset
                      </button>
                    )}
                    <MoreMenu>
                      {status?.ai && <button disabled={busy} onClick={() => reanalyze(false)}>Re-run AI</button>}
                      <button disabled={busy} onClick={() => reanalyze(true)}>Redo OCR</button>
                      <hr />
                      <button className={ui.danger} disabled={busy} onClick={remove}>Move to trash</button>
                    </MoreMenu>
                  </div>
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

/** The line under a row: its question, what filing it does, or its processing state. */
function RowStatus({ doc, t, edited }: { doc: DocumentSummary; t: Triage; edited: boolean }) {
  const e = t.effects;
  let body: React.ReactNode;
  if (t.group === "processing") body = <span className={cx(styles.statusMuted, ui.pulse)}>{doc.status === "queued" && doc.error ? "Failed, retrying soon" : STATUS_LABEL[doc.status]}</span>;
  else if (t.group === "failed") body = <span className={styles.statusAsk}>Couldn’t read · fill in by hand or retry</span>;
  else if (t.questions.length) body = <span className={styles.statusAsk}>? {t.questions[0]}{t.questions.length > 1 ? ` (+${t.questions.length - 1})` : ""}</span>;
  else if (e?.creates.length) body = <span className={styles.statusNew}>+ creates {e.creates.join(", ")}</span>;
  else if (e?.updates.length) body = <span className={styles.statusChange}>~ {e.updates[0]}</span>;
  else if (e?.links.length) body = <span className={styles.statusMuted}>links {e.links.join(", ")}</span>;
  else body = <span className={styles.statusMuted}>Nothing else changes</span>;
  return <span className={styles.rowStatus}>{body}{edited && <span className={styles.edited}> · edited</span>}</span>;
}

function MoreMenu({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  return (
    <details className={cx(ui.menuWrap, styles.more)} ref={ref}>
      <summary className={cx(ui.button, ui.ghost)} aria-label="More actions">⋯</summary>
      <div className={cx(ui.menu, styles.menuUp)} onClick={() => ref.current?.removeAttribute("open")}>{children}</div>
    </details>
  );
}

/**
 * "Is this the 2019 Honda Civic you already have?", with the proposal and
 * the existing object side by side so you can see why it might be.
 */
function Decision(props: {
  proposed: Draft["newObjects"][number];
  existing: ObjectSummary;
  catalog: ComponentDef[];
  objects: ObjectSummary[];
  onYes: () => void;
  onNo: () => void;
}) {
  const { proposed: o, existing, catalog } = props;
  const [detail, setDetail] = useState<ObjectDetail | null>(null);
  useEffect(() => {
    let live = true;
    api.getObject(existing.id).then((d) => live && setDetail(d)).catch(() => {});
    return () => { live = false; };
  }, [existing.id]);

  const rows: Array<{ label: string; mine: string; theirs: string }> = [];
  for (const c of o.components) {
    const def = catalog.find((x) => x.key === c.component);
    const theirs = detail?.current.components.find((x) => x.component === c.component);
    for (const f of def?.fields ?? []) {
      const a = c.values[f.key] ?? null;
      const b = theirs?.values[f.key] ?? null;
      if (empty(a) && empty(b)) continue;
      rows.push({ label: f.label, mine: display(f, a, props.objects), theirs: display(f, b, props.objects) });
    }
  }
  const adds = rows.filter((r) => r.mine && !r.theirs).map((r) => r.label.toLowerCase());

  return (
    <div className={styles.decision} role="group" aria-label="A decision for you">
      <div className={styles.question}>
        <span className={styles.qmark} aria-hidden="true">?</span>
        Is “{o.title}” the {existing.title} you already have?
      </div>
      {rows.length > 0 && (
        <div className={styles.compare}>
          <span /><span className={styles.compareHead}>In this document</span><span className={styles.compareHead}>{existing.title}</span>
          {rows.map((r) => {
            const match = !!r.mine && r.mine.toLowerCase() === r.theirs.toLowerCase();
            return (
              <div className={styles.compareRow} key={r.label}>
                <span className={ui.muted}>{r.label}</span>
                <span className={cx(match && styles.match)}>{r.mine || <em className={ui.muted}>not shown</em>}</span>
                <span className={cx(match && styles.match)}>{r.theirs || <em className={ui.muted}>none yet</em>}</span>
              </div>
            );
          })}
        </div>
      )}
      <div className={styles.decisionActions}>
        <button className={cx(ui.compact, ui.primary)} onClick={props.onYes}>Yes, link it{adds.length ? ` and add the ${adds.join(", ")}` : ""}</button>
        <button className={ui.compact} onClick={props.onNo}>No, create a new one</button>
      </div>
    </div>
  );
}

/**
 * Before filing several documents: each one with what filing it does, so a
 * batch is never filed blind.
 */
function BatchPanel(props: {
  items: DocumentSummary[];
  drafts: (id: string) => Draft | undefined;
  catalog: ComponentDef[];
  objects: ObjectSummary[];
  batch: { done: number; total: number } | null;
  onCancel: () => void;
  onFile: () => void;
  onRemove: (id: string) => void;
}) {
  const { items, catalog, objects } = props;
  const all = items.map((i) => ({ i, d: props.drafts(i.id), e: props.drafts(i.id) ? effectsOf(props.drafts(i.id)!, catalog, objects) : null }));
  const creates = all.reduce((n, x) => n + (x.e?.creates.length ?? 0), 0);
  const changes = all.reduce((n, x) => n + (x.e?.updates.length ?? 0), 0);
  const summary = [
    creates ? `${creates} new object${creates === 1 ? "" : "s"} created` : "Nothing new is created",
    changes ? `${changes} existing object${changes === 1 ? "" : "s"} changed` : "no existing object changes",
  ].join("; ");
  return (
    <section className={styles.batch} aria-label="File several documents">
      <div className={styles.batchHead}>
        <h3>File {items.length} document{items.length === 1 ? "" : "s"}</h3>
        <p className={cx(ui.small, ui.muted)}>{summary}.</p>
      </div>
      <div className={styles.batchList}>
        {all.map(({ i, d, e }) => {
          const total = d && amountOf(d, catalog, objects);
          return (
            <div key={i.id} className={styles.batchRow}>
              <div className={styles.batchMain}>
                <div className={styles.batchTitle}>{d?.title ?? i.title}</div>
                <div className={cx(ui.small, ui.muted)}>
                  {d?.components.map((c) => catalog.find((x) => x.key === c.component)?.name ?? c.component).join(" + ")}
                  {d?.documentDate && ` · ${d.documentDate}`}
                  {!!e?.links.length && ` · links ${e.links.join(", ")}`}
                </div>
                {e?.creates.map((t) => <div key={t} className={styles.batchEffect}><span className={ui.tagNew}>new</span> {t}</div>)}
                {e?.updates.map((t) => <div key={t} className={styles.batchEffect}><span className={ui.tagChange}>change</span> {t}</div>)}
              </div>
              <span className={styles.amount}>{total}</span>
              <button className={ui.icon} title="Leave this one out" onClick={() => props.onRemove(i.id)} disabled={!!props.batch}>✕</button>
            </div>
          );
        })}
      </div>
      <p className={cx(ui.small, ui.muted, styles.batchNote)}>Documents that only link to or update existing objects are filed first, so later ones can find what they add.</p>
      <div className={styles.batchActions}>
        {props.batch ? (
          <span className={ui.small}>Filing {props.batch.done} of {props.batch.total}…</span>
        ) : (
          <>
            <button className={cx(ui.primary, styles.fileBtn)} onClick={props.onFile}>File {items.length}</button>
            <button onClick={props.onCancel}>Cancel</button>
          </>
        )}
      </div>
    </section>
  );
}

function amountOf(d: Draft, catalog: ComponentDef[], objects: ObjectSummary[]): string {
  const defs = defsFor(catalog, d);
  for (const c of d.components) {
    for (const f of defs.get(c.component)?.fields ?? []) {
      const v = c.values[f.key];
      if (f.type === "money" && typeof v === "number") return display({ ...f, options: {} }, v, objects);
    }
  }
  return "";
}
