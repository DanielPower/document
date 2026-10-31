import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { DraftEditor } from "../components/DraftEditor";
import { DraftView } from "../components/DraftView";
import { cx } from "../cx";
import { useAppData } from "../data";
import ui from "../ui.module.css";
import styles from "./ObjectPage.module.css";
import type { ComponentDef, DocumentSummary, Draft, ObjectDetail } from "../types";

const EMPTY: Draft = { title: "", documentDate: null, components: [], newComponents: [], newObjects: [] };

/** Money spent per year, per money field, over the linked filed documents. */
interface SpendRow { label: string; currency: string; byYear: Map<string, number>; total: number }

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
        const row = rows.get(path) ?? { label: `${def!.name} › ${f.label}`, currency: f.options.currency ?? "", byYear: new Map(), total: 0 };
        row.byYear.set(year, (row.byYear.get(year) ?? 0) + v);
        row.total += v;
        rows.set(path, row);
      }
    }
  }
  return [...rows.values()];
}

const money = (v: number, unit: string) => `${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${unit ? ` ${unit}` : ""}`;

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
  const years = useMemo(() => [...new Set(spend.flatMap((r) => [...r.byYear.keys()]))].sort().reverse(), [spend]);

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
        <p><Link to="/objects">← Objects</Link></p>
        <h2>{isNew ? "New object" : `Edit ${obj?.title ?? ""}`}</h2>
        <DraftEditor draft={draft} onChange={setDraft} catalog={catalog} objects={objects} selfId={isNew ? undefined : id} />
        <label>
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

  const byYear = new Map<string, DocumentSummary[]>();
  for (const d of docs) {
    const y = d.documentDate?.slice(0, 4) ?? "No date";
    byYear.set(y, [...(byYear.get(y) ?? []), d]);
  }
  const docYears = [...byYear.keys()].sort((a, b) => (a === "No date" ? 1 : b === "No date" ? -1 : b.localeCompare(a)));
  /** The first money value on a document, shown beside it in the timeline. */
  const amount = (d: DocumentSummary) => {
    for (const c of d.values ?? []) {
      const def = catalog.find((x) => x.key === c.component);
      const f = def?.fields.find((x) => x.type === "money" && typeof c.values[x.key] === "number");
      if (f) return money(c.values[f.key] as number, f.options.currency ?? "");
    }
    return "";
  };

  return (
    <div className={cx(ui.page, ui.narrow)}>
      <p><Link to="/objects">← Objects</Link></p>
      <div className={styles.head}>
        <div className={ui.grow}>
          <h2>{obj?.title}</h2>
          <div className={ui.badges}>
            {draft.components.map((c, i) => {
              const def = catalog.find((x) => x.key === c.component);
              return <span key={i} className={ui.badge} style={{ background: def?.color }}>{def?.name ?? c.component}</span>;
            })}
          </div>
        </div>
        <button className={ui.primary} onClick={() => setEditing(true)}>Edit</button>
        <details className={styles.more}>
          <summary className={ui.button} aria-label="More actions">⋯</summary>
          <div className={styles.menu}>
            <label>
              Same thing as another object? Merge this one into it
              <select value={mergeInto} onChange={(e) => setMergeInto(e.target.value)}>
                <option value="">Choose the object to keep…</option>
                {objects.filter((o) => o.id !== id).map((o) => <option key={o.id} value={o.id}>{o.title}</option>)}
              </select>
            </label>
            <button disabled={busy || !mergeInto} onClick={merge}>Merge</button>
            <hr />
            <button className={ui.danger} disabled={busy} onClick={remove}>Delete object</button>
          </div>
        </details>
      </div>

      <DraftView components={draft.components} catalog={catalog} objects={objects} notes={notes} />

      {!!obj?.linkedFrom.length && (
        <section className={styles.section}>
          <h3>Linked from</h3>
          <div className={ui.badges}>
            {obj.linkedFrom.map((o) => <Link key={o.id} className={styles.pill} to={`/objects/${o.id}`}>{o.title}</Link>)}
          </div>
        </section>
      )}

      {spend.length > 0 && (
        <section className={styles.section}>
          <h3>Spending</h3>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr><th />{years.map((y) => <th key={y} className={styles.num}>{y}</th>)}<th className={styles.num}>Total</th></tr>
              </thead>
              <tbody>
                {spend.map((r) => (
                  <tr key={r.label}>
                    <td>{r.label}</td>
                    {years.map((y) => <td key={y} className={styles.num}>{r.byYear.has(y) ? money(r.byYear.get(y)!, r.currency) : "—"}</td>)}
                    <td className={cx(styles.num, styles.total)}>{money(r.total, r.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className={cx(ui.muted, ui.small)}>Filed documents linked to this object. <Link to={`/documents?ref=${id}&status=all`}>Search them</Link></p>
        </section>
      )}

      <section className={styles.section}>
        <h3>Documents ({docs.length})</h3>
        {!docs.length && <p className={ui.muted}>No documents link to this object yet.</p>}
        {docYears.map((y) => (
          <div key={y} className={styles.year}>
            <div className={styles.yearLabel}>{y}</div>
            <div className={ui.list}>
              {byYear.get(y)!.map((d) => (
                <Link key={d.id} to={d.status === "inbox" ? `/inbox/${d.id}` : `/documents/${d.id}`} className={ui.listItem}>
                  <div>
                    <div className={ui.listTitle}>{d.title}</div>
                    <div className={cx(ui.muted, ui.small)}>
                      {d.documentDate ?? "no date"}
                      {d.status === "inbox" && " · in the inbox"}
                    </div>
                  </div>
                  <span className={styles.amount}>{amount(d)}</span>
                </Link>
              ))}
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
