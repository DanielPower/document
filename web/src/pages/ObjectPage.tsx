import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { DraftEditor } from "../components/DraftEditor";
import { DraftView } from "../components/DraftView";
import { ComponentChip, ComponentDots } from "../components/Chip";
import { cx } from "../cx";
import { useAppData } from "../data";
import ui from "../ui.module.css";
import styles from "./ObjectPage.module.css";
import type { ComponentDef, DocumentSummary, Draft, ObjectDetail } from "../types";

const EMPTY: Draft = { title: "", documentDate: null, components: [], newComponents: [], newObjects: [] };

/** Money spent per year, per money field, over the linked filed documents. */
interface SpendRow { path: string; label: string; currency: string; byYear: Map<string, number>; total: number }

function spending(docs: DocumentSummary[], catalog: ComponentDef[]): SpendRow[] {
  const rows = new Map<string, SpendRow>();
  for (const d of docs) {
    if (d.status !== "filed") continue;
    const year = d.documentDate?.slice(0, 4) ?? "No date";
    // Count each field once per document, even if the component is attached twice.
    const seen = new Set<string>();
    for (const c of d.values ?? []) {
      const def = catalog.find((x) => x.key === c.component);
      for (const f of def?.fields ?? []) {
        const v = c.values[f.key];
        const path = `${c.component}.${f.key}`;
        if (f.type !== "money" || typeof v !== "number" || seen.has(path)) continue;
        seen.add(path);
        const row = rows.get(path) ?? { path, label: `${def!.name} › ${f.label}`, currency: f.options.currency ?? "", byYear: new Map(), total: 0 };
        row.byYear.set(year, (row.byYear.get(year) ?? 0) + v);
        row.total += v;
        rows.set(path, row);
      }
    }
  }
  return [...rows.values()];
}

const money = (v: number, unit: string) => `${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${unit ? ` ${unit}` : ""}`;

export function ObjectPage() {
  const { id } = useParams();
  const isNew = id === "new";
  const navigate = useNavigate();
  const { catalog, objects, refresh, toast } = useAppData();
  const [obj, setObj] = useState<ObjectDetail | null>(null);
  const [draft, setDraft] = useState<Draft | null>(isNew ? structuredClone(EMPTY) : null);
  const [notes, setNotes] = useState("");
  const [docs, setDocs] = useState<DocumentSummary[]>([]);
  const [editing, setEditing] = useState(isNew);
  const [busy, setBusy] = useState(false);
  const [mergeInto, setMergeInto] = useState("");

  const load = async (objectId: string) => {
    const o = await api.getObject(objectId);
    setObj(o);
    setDraft(structuredClone(o.current));
    setNotes(o.notes);
  };

  useEffect(() => {
    setEditing(isNew);
    if (isNew) { setObj(null); setDraft(structuredClone(EMPTY)); setNotes(""); setDocs([]); return; }
    load(id!).catch((e) => toast(e.message, "error"));
    api.searchDocuments({ ref: id, status: ["filed", "inbox"], limit: 200, values: true }).then((r) => setDocs(r.items)).catch(() => {});
  }, [id, isNew, toast]); // eslint-disable-line react-hooks/exhaustive-deps

  const spend = useMemo(() => spending(docs, catalog), [docs, catalog]);

  if (!draft) return <div className={cx(ui.page, ui.muted)}>Loading…</div>;

  const save = async () => {
    setBusy(true);
    try {
      if (isNew) {
        const { id: newId } = await api.createObject(draft, notes);
        await refresh();
        navigate(`/objects/${newId}`, { replace: true });
      } else {
        await api.saveObject(id!, draft, notes);
        await Promise.all([refresh(), load(id!)]);
        setEditing(false);
      }
      toast("Saved");
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => {
    if (isNew) return navigate("/objects");
    if (obj) { setDraft(structuredClone(obj.current)); setNotes(obj.notes); }
    setEditing(false);
  };

  const merge = async () => {
    const target = objects.find((o) => o.id === mergeInto);
    if (!target || !confirm(`Merge "${draft.title}" into "${target.title}"? Its ${docs.length} linked document(s) will point at "${target.title}", details it lacks are copied over, and this object is deleted.`)) return;
    setBusy(true);
    try {
      const r = await api.mergeObject(id!, mergeInto);
      toast(`Merged into "${target.title}".` + (r.discarded.length ? ` Kept its values over: ${r.discarded.join("; ")}.` : ""));
      await refresh();
      navigate(`/objects/${mergeInto}`);
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirm(`Delete this object? ${docs.length} document(s) link to it; those links will be cleared. This can't be undone.`)) return;
    try { await api.deleteObject(id!); await refresh(); navigate("/objects"); } catch (e) { toast((e as Error).message, "error"); }
  };

  if (editing) {
    return (
      <div className={cx(ui.page, ui.narrow)}>
        <p className={styles.crumb}><Link to={isNew ? "/objects" : `/objects/${id}`}>‹ {isNew ? "Objects" : obj?.title ?? "Back"}</Link></p>
        <h2>{isNew ? "New object" : `Edit ${obj?.title ?? ""}`}</h2>
        <DraftEditor draft={draft} onChange={setDraft} catalog={catalog} objects={objects} selfId={isNew ? undefined : id} />
        <label className={styles.notesLabel}>
          Notes
          <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
        <div className={ui.actions}>
          <button className={ui.primary} disabled={busy || !draft.title.trim()} onClick={save}>{isNew ? "Create" : "Save"}</button>
          <button disabled={busy} onClick={cancel}>Cancel</button>
        </div>
      </div>
    );
  }

  // The ledger and the totals follow the money field with the largest total (an invoice's Total, usually).
  const primary = spend.slice().sort((a, b) => b.total - a.total)[0];
  const others = spend.filter((r) => r !== primary);
  const thisYear = String(new Date().getFullYear());
  const amountFor = (d: DocumentSummary): number | null => {
    if (!primary) return null;
    for (const c of d.values ?? []) {
      if (`${c.component}` !== primary.path.split(".")[0]) continue;
      const v = c.values[primary.path.split(".")[1]];
      if (typeof v === "number") return v;
    }
    return null;
  };
  /** Any other money value, shown muted (a registration fee, say), so a row is never blank without reason. */
  const otherAmount = (d: DocumentSummary) => {
    for (const c of d.values ?? []) {
      const def = catalog.find((x) => x.key === c.component);
      const f = def?.fields.find((x) => x.type === "money" && typeof c.values[x.key] === "number");
      if (f) return `${money(c.values[f.key] as number, "")} ${f.label.toLowerCase()}`;
    }
    return "";
  };
  const byMonth = Array.from({ length: 12 }, (_, m) =>
    docs.filter((d) => d.status === "filed" && d.documentDate?.startsWith(`${thisYear}-${String(m + 1).padStart(2, "0")}`)).reduce((n, d) => n + (amountFor(d) ?? 0), 0));
  const peak = Math.max(...byMonth, 1);
  const docYears = [...new Set(docs.map((d) => d.documentDate?.slice(0, 4) ?? "No date"))].sort((a, b) => (a === "No date" ? 1 : b === "No date" ? -1 : b.localeCompare(a)));

  return (
    <div className={styles.page}>
      <aside className={styles.left}>
        <div className={styles.head}>
          <Link className={cx(ui.small, styles.crumb)} to="/objects">‹ Objects</Link>
          <div className={styles.titleRow}>
            <h2 className={styles.title}>{obj?.title}</h2>
            {draft.components.map((c, i) => <ComponentChip key={i} componentKey={c.component} catalog={catalog} />)}
          </div>
          <div className={styles.headActions}>
            <button className={ui.compact} onClick={() => setEditing(true)}>Edit</button>
            <details className={ui.menuWrap}>
              <summary className={cx(ui.button, ui.compact, ui.ghost)}>Merge…</summary>
              <div className={cx(ui.menu, styles.mergeMenu)}>
                <label>
                  Same thing as another object? Merge this one into it
                  <select value={mergeInto} onChange={(e) => setMergeInto(e.target.value)}>
                    <option value="">Choose the object to keep…</option>
                    {objects.filter((o) => o.id !== id).map((o) => <option key={o.id} value={o.id}>{o.title}</option>)}
                  </select>
                </label>
                <button className={cx(ui.compact, ui.primary, styles.mergeBtn)} disabled={busy || !mergeInto} onClick={merge}>Merge</button>
              </div>
            </details>
            <details className={ui.menuWrap}>
              <summary className={cx(ui.button, ui.compact, ui.ghost)} aria-label="More actions">⋯</summary>
              <div className={ui.menu}>
                <Link to={`/documents?ref=${id}&status=all`}>Search its documents</Link>
                <hr />
                <button className={ui.danger} disabled={busy} onClick={remove}>Delete object</button>
              </div>
            </details>
          </div>
        </div>
        <div className={styles.leftBody}>
          <DraftView components={draft.components} catalog={catalog} objects={objects} notes={notes} sources={obj?.sources} />
          {!!obj?.linkedFrom.length && (
            <section>
              <div className={ui.sectionHead}>Linked from</div>
              <div className={ui.list}>
                {obj.linkedFrom.map((o) => <Link key={o.id} className={ui.listItem} to={`/objects/${o.id}`}><div>{o.title}</div></Link>)}
              </div>
            </section>
          )}
        </div>
      </aside>

      <div className={styles.right}>
        {primary && (
          <div className={styles.stats}>
            <div title={primary.label}><span className={styles.statLabel}>Spent in {thisYear}</span><span className={styles.statValue}>{money(primary.byYear.get(thisYear) ?? 0, "")} <span className={styles.unit}>{primary.currency}</span></span></div>
            <div title={primary.label}><span className={styles.statLabel}>All time</span><span className={styles.statValue}>{money(primary.total, "")}</span></div>
            <div><span className={styles.statLabel}>Documents</span><span className={styles.statValue}>{docs.length}</span></div>
            <div title={`${primary.label} by month, ${thisYear}`}>
              <span className={styles.statLabel}>By month, {thisYear}</span>
              <span className={styles.bars} aria-hidden="true">
                {byMonth.map((v, m) => <i key={m} className={cx(m === new Date().getMonth() && styles.barNow)} style={{ height: `${Math.max(v ? 8 : 3, (v / peak) * 100)}%` }} />)}
              </span>
            </div>
          </div>
        )}
        {!docs.length ? (
          <p className={ui.muted}>No documents link to this object yet.</p>
        ) : (
          <div className={ui.tableWrap}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Document</th>
                  <th>Kind</th>
                  {primary && <th className={ui.num} title={primary.label}>{primary.label.split(" › ")[1] ?? primary.label} {primary.currency}</th>}
                </tr>
              </thead>
              {docYears.map((y) => {
                const rows = docs.filter((d) => (d.documentDate?.slice(0, 4) ?? "No date") === y);
                const sub = rows.reduce((n, d) => n + (d.status === "filed" ? amountFor(d) ?? 0 : 0), 0);
                return (
                  <tbody key={y}>
                    <tr className={styles.year}>
                      <td colSpan={3}>{y}</td>
                      {primary && <td className={ui.num}>{sub ? money(sub, "") : ""}</td>}
                    </tr>
                    {rows.map((d) => {
                      const a = amountFor(d);
                      return (
                        <tr key={d.id}>
                          <td className={styles.date}>{d.documentDate ?? ""}</td>
                          <td className={styles.docTitle}>
                            <Link to={d.status === "inbox" ? `/inbox/${d.id}` : `/documents/${d.id}`}>{d.title}</Link>
                            {d.status === "inbox" && <span className={cx(ui.small, ui.muted)}> · in the inbox</span>}
                          </td>
                          <td><ComponentDots keys={d.components} catalog={catalog} /> <span className={ui.small}>{d.components.map((k) => catalog.find((c) => c.key === k)?.name ?? k).filter((n) => !/related|asset/i.test(n)).join(", ")}</span></td>
                          {primary && <td className={ui.num}>{a !== null ? money(a, "") : <span className={ui.muted}>{otherAmount(d)}</span>}</td>}
                        </tr>
                      );
                    })}
                  </tbody>
                );
              })}
            </table>
          </div>
        )}
        {primary && (
          <p className={cx(ui.small, ui.muted, styles.note)}>
            Totals add {primary.label} over filed documents.
            {others.length > 0 && <> Also: {others.map((r) => `${r.label} ${money(r.total, r.currency)}`).join("; ")}.</>}
          </p>
        )}
      </div>
    </div>
  );
}
