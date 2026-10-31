import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, thumbUrl } from "../api";
import { allColumns, defaultColumns, DocumentTable, toCsv } from "../components/DocumentTable";
import { cx } from "../cx";
import { useAppData } from "../data";
import ui from "../ui.module.css";
import styles from "./Documents.module.css";
import type { AggregateResult, AggregateSpec, ComponentDef, DocumentSummary, ObjectSummary } from "../types";

const OPS_BY_TYPE: Record<string, Array<[string, string]>> = {
  number: [["eq", "="], ["gt", ">"], ["gte", "≥"], ["lt", "<"], ["lte", "≤"], ["set", "has value"], ["empty", "is empty"]],
  date: [["eq", "on"], ["gte", "on/after"], ["lte", "on/before"], ["set", "has value"], ["empty", "is empty"]],
  boolean: [["eq", "is"]],
  text: [["contains", "contains"], ["eq", "is"], ["set", "has value"], ["empty", "is empty"]],
  ref: [["eq", "is"], ["set", "has value"], ["empty", "is empty"]],
};
const opsFor = (type: string) => OPS_BY_TYPE[type === "money" ? "number" : type === "longtext" || type === "select" ? "text" : type] ?? OPS_BY_TYPE.text;

/** Search state lives in the URL so searches (including AI-interpreted ones) can be bookmarked. */
export function DocumentsPage() {
  const { catalog, objects, status: appStatus, toast } = useAppData();
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const components = params.getAll("c");
  const where = params.getAll("w");
  const status = params.get("status") ?? "filed";
  const ref = params.get("ref") ?? "";
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  const semantic = params.get("sem") !== "0";
  const sort = params.get("sort") ?? (q ? "relevance" : "date");
  const explanation = params.get("explain");
  const aggParam = params.get("agg");
  const agg = useMemo<AggregateSpec | null>(() => {
    try {
      return aggParam ? (JSON.parse(aggParam) as AggregateSpec) : null;
    } catch {
      return null;
    }
  }, [aggParam]);
  const [text, setText] = useState(q);
  const [items, setItems] = useState<DocumentSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [usedSemantic, setUsedSemantic] = useState(false);
  const [aggResult, setAggResult] = useState<AggregateResult | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [interpreting, setInterpreting] = useState(false);
  /** Cards or a table; remembered on this device. */
  const [view, setViewState] = useState<"cards" | "table">(() => (localStorage.getItem("docket.view") === "table" ? "table" : "cards"));
  const setView = (v: "cards" | "table") => { localStorage.setItem("docket.view", v); setViewState(v); };
  /** Field columns the owner picked for the table; null = chosen from the results. */
  const [picked, setPickedState] = useState<string[] | null>(() => {
    try { return JSON.parse(localStorage.getItem("docket.columns") ?? "null"); } catch { return null; }
  });
  const setPicked = (v: string[] | null) => { localStorage.setItem("docket.columns", JSON.stringify(v)); setPickedState(v); };
  const [exporting, setExporting] = useState(false);
  /** Phones only: the filters fold away behind a button. */
  const [showFilters, setShowFilters] = useState(false);

  useEffect(() => setText(q), [q]);

  /** Any manual change to the filters means the AI's explanation no longer describes them. */
  const update = (mut: (p: URLSearchParams) => void, keepExplanation = false) => {
    const p = new URLSearchParams(params);
    mut(p);
    if (!keepExplanation) p.delete("explain");
    setParams(p, { replace: true });
  };

  const query = useMemo(
    () => ({
      q,
      component: components,
      where,
      ref: ref || undefined,
      from: from || undefined,
      to: to || undefined,
      status: status === "all" ? undefined : [status],
      sort,
      semantic,
      limit: 60,
      values: view === "table",
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [params.toString(), view],
  );

  useEffect(() => {
    setLoading(true);
    api.searchDocuments(query)
      .then((r) => { setItems(r.items); setTotal(r.total); setUsedSemantic(r.semantic); })
      .catch((e) => toast(e.message, "error"))
      .finally(() => setLoading(false));
  }, [query, toast]);

  // Totals follow the current filters, so editing a filter updates them.
  useEffect(() => {
    if (!agg) { setAggResult(null); return; }
    api.aggregate(query, agg).then(setAggResult).catch((e) => { setAggResult(null); toast(e.message, "error"); });
  }, [query, agg, toast]);

  const columnsAll = useMemo(() => allColumns(catalog), [catalog]);
  const columns = useMemo(() => {
    const paths = picked ?? defaultColumns(items, catalog);
    return paths.map((p) => columnsAll.find((c) => c.path === p)).filter((c) => !!c);
  }, [picked, items, catalog, columnsAll]);

  /** Downloads every matching document (not just the loaded page) as CSV. */
  const exportCsv = async () => {
    setExporting(true);
    try {
      const all: DocumentSummary[] = [];
      for (;;) {
        const r = await api.searchDocuments({ ...query, values: true, limit: 200, offset: all.length });
        all.push(...r.items);
        if (!r.items.length || all.length >= r.total) break;
      }
      const blob = new Blob([toCsv(all, columns, catalog, objects)], { type: "text/csv;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `docket-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setExporting(false);
    }
  };

  const loadMore = async () => {
    const r = await api.searchDocuments({ ...query, offset: items.length });
    setItems([...items, ...r.items]);
  };

  /** Sends the search box text to the AI and replaces the filters with its interpretation. */
  const interpret = async () => {
    if (!text.trim()) return;
    setInterpreting(true);
    try {
      const r = await api.interpret(text.trim());
      const p = new URLSearchParams();
      if (r.q) p.set("q", r.q);
      r.components.forEach((c) => p.append("c", c));
      r.where.forEach((w) => p.append("w", w));
      if (r.ref) p.set("ref", r.ref);
      if (r.from) p.set("from", r.from);
      if (r.to) p.set("to", r.to);
      p.set("status", "all");
      p.set("sort", r.sort);
      if (r.aggregate) p.set("agg", JSON.stringify(r.aggregate));
      p.set("explain", r.explanation);
      setWarnings(r.warnings);
      setParams(p);
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setInterpreting(false);
    }
  };

  const filterCount = components.length + where.length + (ref ? 1 : 0) + (from || to ? 1 : 0);
  const hasFilters = !!(q || components.length || where.length || ref || from || to || agg);

  return (
    <div className={ui.page}>
      <form className={styles.searchbar} onSubmit={(e) => { e.preventDefault(); update((p) => (text ? p.set("q", text) : p.delete("q"))); }}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={appStatus?.ai ? 'Search, or ask: "unpaid house bills this year"' : 'Search text, e.g. brake "kingsway auto" -oil'}
          autoFocus={!matchMedia("(max-width: 700px)").matches}
        />
        <select value={status} onChange={(e) => update((p) => p.set("status", e.target.value), true)}>
          <option value="filed">Filed</option>
          <option value="inbox">In inbox</option>
          <option value="all">All</option>
        </select>
        <select value={sort} onChange={(e) => update((p) => p.set("sort", e.target.value), true)}>
          {q && <option value="relevance">Best match</option>}
          <option value="date">Document date</option>
          <option value="added">Recently added</option>
          <option value="title">Title</option>
        </select>
        <button className={ui.primary}>Search</button>
        {appStatus?.ai && (
          <button type="button" disabled={interpreting || !text.trim()} onClick={interpret} title="Let AI turn your question into filters">
            {interpreting ? "Thinking…" : "Ask AI"}
          </button>
        )}
      </form>

      {explanation && (
        <div className={ui.aiNote}>
          <div className={ui.aiNoteHead}>AI interpreted your question as</div>
          <p>{explanation}</p>
          {warnings.length > 0 && <p className={cx(ui.small, ui.muted)}>{warnings.join(" ")}</p>}
          <p className={cx(ui.small, ui.muted)}>The filters below are what's actually applied; change any of them to refine.</p>
        </div>
      )}

      <button className={styles.filterToggle} onClick={() => setShowFilters((v) => !v)} aria-expanded={showFilters}>
        {showFilters ? "Hide filters" : `Filters${filterCount ? ` (${filterCount})` : ""}`}
      </button>

      {agg && aggResult && <AggregatePanel result={aggResult} onRemove={() => update((p) => p.delete("agg"), true)} />}

      <div className={cx(styles.filterPanel, showFilters && styles.filterPanelOpen)}>
      <div className={styles.filters}>
        <span className={cx(ui.muted, ui.small)}>Has:</span>
        {catalog.map((c) => {
          const on = components.includes(c.key);
          return (
            <button
              key={c.key}
              className={cx(styles.chip, on && styles.chipOn)}
              style={on ? { background: c.color, borderColor: c.color } : { borderColor: c.color }}
              onClick={() => update((p) => {
                p.delete("c");
                (on ? components.filter((k) => k !== c.key) : [...components, c.key]).forEach((k) => p.append("c", k));
              })}
            >
              {c.name}
            </button>
          );
        })}
        <select value={ref} onChange={(e) => update((p) => (e.target.value ? p.set("ref", e.target.value) : p.delete("ref")))}>
          <option value="">Linked to any object</option>
          {objects.map((o) => <option key={o.id} value={o.id}>Linked to {o.title}</option>)}
        </select>
        <label className={cx(ui.inline, ui.small, ui.muted)}>
          From <input type="date" value={from} onChange={(e) => update((p) => (e.target.value ? p.set("from", e.target.value) : p.delete("from")))} />
        </label>
        <label className={cx(ui.inline, ui.small, ui.muted)}>
          to <input type="date" value={to} onChange={(e) => update((p) => (e.target.value ? p.set("to", e.target.value) : p.delete("to")))} />
        </label>
        {hasFilters && <button className={cx(ui.link, ui.small)} onClick={() => { setText(""); setParams(new URLSearchParams()); }}>Clear all</button>}
      </div>

      <FieldFilters
        catalog={catalog}
        objects={objects}
        where={where}
        onChange={(w) => update((p) => { p.delete("w"); w.forEach((x) => p.append("w", x)); })}
      />
      </div>

      <p className={cx(ui.muted, ui.small)}>
        {loading ? "Searching…" : `${total} document${total === 1 ? "" : "s"}`}
        {q && appStatus?.semantic.available && (
          <label className={cx(ui.inline, styles.meaningToggle)} title="Also find documents that match by meaning, not just by words">
            <input type="checkbox" checked={semantic} onChange={(e) => update((p) => (e.target.checked ? p.delete("sem") : p.set("sem", "0")), true)} />
            match by meaning{q && semantic && !usedSemantic && !loading ? " (unavailable right now)" : ""}
          </label>
        )}
      </p>
      <div className={styles.viewBar}>
        <div className={styles.segmented} role="group" aria-label="View">
          <button className={cx(view === "cards" && styles.segOn)} onClick={() => setView("cards")}>Cards</button>
          <button className={cx(view === "table" && styles.segOn)} onClick={() => setView("table")}>Table</button>
        </div>
        {view === "table" && (
          <details className={styles.columnsMenu}>
            <summary className={cx(ui.button, ui.compact)}>Columns</summary>
            <div className={styles.columnsList}>
              <button className={cx(ui.link, ui.small)} onClick={() => setPicked(null)} disabled={picked === null}>Automatic (from the results)</button>
              {catalog.filter((c) => c.fields.some((f) => f.type !== "longtext")).map((c) => (
                <fieldset key={c.key} className={styles.columnGroup}>
                  <legend>{c.name}</legend>
                  {columnsAll.filter((x) => x.component.key === c.key).map((x) => (
                    <label key={x.path} className={ui.inline}>
                      <input
                        type="checkbox"
                        checked={columns.some((y) => y.path === x.path)}
                        onChange={(e) => {
                          const now = columns.map((y) => y.path);
                          setPicked(e.target.checked ? [...now, x.path] : now.filter((p) => p !== x.path));
                        }}
                      />
                      {x.field.label}
                    </label>
                  ))}
                </fieldset>
              ))}
            </div>
          </details>
        )}
        <button className={ui.compact} disabled={exporting || !total} onClick={exportCsv} title="Every matching document, with the table's columns">
          {exporting ? "Exporting…" : "Export CSV"}
        </button>
        <span className={ui.spacer} />
        <Link className={ui.small} to="/trash">Trash</Link>
      </div>
      {view === "table" ? (
        <DocumentTable items={items} columns={columns} catalog={catalog} objects={objects} />
      ) : (
      <div className={styles.grid}>
        {items.map((d) => (
          <Link key={d.id} to={`/documents/${d.id}`} className={styles.card}>
            {d.hasThumb ? <img className={styles.cardThumb} src={thumbUrl(d.id)} alt="" loading="lazy" /> : <div className={cx(ui.thumbPlaceholder, ui.thumbPlaceholderLarge)}>{d.mimeType.split("/")[1]}</div>}
            <div className={styles.cardBody}>
              <div className={styles.cardTitle}>{d.title}</div>
              <div className={cx(ui.muted, ui.small)}>{d.documentDate ?? "no date"}</div>
              <div className={ui.badges}>
                {d.components.map((k, i) => {
                  const c = catalog.find((x) => x.key === k);
                  return <span key={i} className={ui.badge} style={{ background: c?.color }}>{c?.name ?? k}</span>;
                })}
              </div>
              {d.match === "meaning" && <div className={cx(styles.matchNote, ui.small)}>Similar meaning; the words don't appear</div>}
              {d.snippet && <div className={styles.snippet} dangerouslySetInnerHTML={{ __html: sanitizeSnippet(d.snippet) }} />}
            </div>
          </Link>
        ))}
      </div>
      )}
      {items.length < total && <button onClick={loadMore}>Load more</button>}
    </div>
  );
}

function AggregatePanel({ result, onRemove }: { result: AggregateResult; onRemove: () => void }) {
  const fmt = (v: number | null) =>
    v === null ? "—" : `${v.toLocaleString(undefined, { minimumFractionDigits: result.unit ? 2 : 0, maximumFractionDigits: 2 })}${result.unit ? ` ${result.unit}` : ""}`;
  const groupLabel = { none: "", year: "Year", month: "Month", object: "Linked to" }[result.groupBy];
  return (
    <div className={styles.aggregate}>
      <div className={styles.aggregateHead}>
        <strong>{result.label}</strong>
        <button className={ui.icon} title="Remove total" onClick={onRemove}>✕</button>
      </div>
      {result.groupBy === "none" ? (
        <div className={styles.aggregateValue}>
          {fmt(result.rows[0]?.value ?? 0)} <span className={cx(ui.muted, ui.small)}>over {result.rows[0]?.documents ?? 0} documents</span>
        </div>
      ) : (
        <table>
          <thead><tr><th>{groupLabel}</th><th>Value</th><th>Documents</th></tr></thead>
          <tbody>
            {result.rows.map((r, i) => (
              <tr key={i}><td>{r.group ?? (result.groupBy === "object" ? "Not linked" : "No date")}</td><td>{fmt(r.value)}</td><td>{r.documents}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function FieldFilters(props: { where: string[]; onChange: (w: string[]) => void; catalog: ComponentDef[]; objects: ObjectSummary[] }) {
  const { catalog, objects } = props;
  const fields = catalog.flatMap((c) => c.fields.map((f) => ({ c, f, path: `${c.key}.${f.key}` })));
  const [path, setPath] = useState("");
  const sel = fields.find((x) => x.path === path);
  const [op, setOp] = useState("");
  const [val, setVal] = useState("");
  const ops = sel ? opsFor(sel.f.type) : [];
  const describe = (w: string) => {
    const m = /^([^.]+)\.([^:]+):([^:]+)(?::(.*))?$/s.exec(w);
    if (!m) return w;
    const x = fields.find((y) => y.path === `${m[1]}.${m[2]}`);
    const opLabel = x ? opsFor(x.f.type).find(([o]) => o === m[3])?.[1] ?? m[3] : m[3];
    const v =
      x?.f.type === "ref" ? objects.find((o) => o.id === m[4])?.title ?? m[4] :
      x?.f.type === "boolean" ? (m[4] === "true" ? "Yes" : m[4] === "false" ? "No" : m[4]) :
      m[4];
    return `${x ? `${x.c.name} › ${x.f.label}` : `${m[1]}.${m[2]}`} ${opLabel} ${v ?? ""}`;
  };
  return (
    <div className={styles.filters}>
      {props.where.map((w, i) => (
        <span key={i} className={cx(styles.chip, styles.chipFilter)}>
          {describe(w)} <button className={ui.icon} onClick={() => props.onChange(props.where.filter((_, j) => j !== i))}>✕</button>
        </span>
      ))}
      <select value={path} onChange={(e) => { setPath(e.target.value); setOp(""); setVal(""); }}>
        <option value="">+ Field filter…</option>
        {catalog.filter((c) => c.fields.length).map((c) => (
          <optgroup key={c.key} label={c.name}>
            {c.fields.map((f) => <option key={f.key} value={`${c.key}.${f.key}`}>{f.label}</option>)}
          </optgroup>
        ))}
      </select>
      {sel && (
        <>
          <select value={op || ops[0][0]} onChange={(e) => setOp(e.target.value)}>
            {ops.map(([o, l]) => <option key={o} value={o}>{l}</option>)}
          </select>
          {!["set", "empty"].includes(op || ops[0][0]) && (
            sel.f.type === "boolean" ? (
              <select value={val} onChange={(e) => setVal(e.target.value)}><option value="">—</option><option value="true">Yes</option><option value="false">No</option></select>
            ) : sel.f.type === "ref" ? (
              <select value={val} onChange={(e) => setVal(e.target.value)}>
                <option value="">—</option>
                {objects.map((o) => <option key={o.id} value={o.id}>{o.title}</option>)}
              </select>
            ) : sel.f.type === "select" ? (
              <select value={val} onChange={(e) => setVal(e.target.value)}>
                <option value="">—</option>
                {(sel.f.options.choices ?? []).map((c) => <option key={c}>{c}</option>)}
              </select>
            ) : (
              <input type={sel.f.type === "date" ? "date" : ["number", "money"].includes(sel.f.type) ? "number" : "text"} value={val} onChange={(e) => setVal(e.target.value)} />
            )
          )}
          <button
            className={ui.compact}
            onClick={() => {
              const o = op || ops[0][0];
              props.onChange([...props.where, ["set", "empty"].includes(o) ? `${path}:${o}` : `${path}:${o}:${val}`]);
              setPath("");
            }}
          >
            Add
          </button>
        </>
      )}
    </div>
  );
}

/** Snippets come from ts_headline over OCR text: escape everything except our <mark> tags. */
function sanitizeSnippet(s: string): string {
  return s
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/&lt;mark&gt;/g, "<mark>").replace(/&lt;\/mark&gt;/g, "</mark>");
}
