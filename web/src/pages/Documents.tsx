import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, thumbUrl } from "../api";
import { ComponentChip, Dot } from "../components/Chip";
import { allColumns, defaultColumns, DocumentTable, toCsv } from "../components/DocumentTable";
import { DraftView } from "../components/DraftView";
import { DateInput } from "../components/FieldInputs";
import { cx } from "../cx";
import { useAppData } from "../data";
import ui from "../ui.module.css";
import styles from "./Documents.module.css";
import type { AggregateResult, AggregateSpec, ComponentDef, DocumentDetail, DocumentSummary, ObjectSummary } from "../types";

/** A question for the AI rather than words to search for. */
const looksLikeQuestion = (s: string) =>
  /\?\s*$/.test(s) || /^(how|what|when|where|which|who|why|show|list|find|all)\b/i.test(s) || /\b(this|last|next) (year|month|week)\b/i.test(s) || /\b(unpaid|overdue|paid|due)\b/i.test(s);

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
  const navigate = useNavigate();
  const filterMenu = useRef<HTMLDetailsElement>(null);
  /** A table or cards; remembered on this device. The table is the default. */
  const [view, setViewState] = useState<"cards" | "table">(() => {
    // Table by default; cards on phones, where a wide table doesn't fit. A choice you made wins.
    const saved = localStorage.getItem("docket.view");
    if (saved === "cards" || saved === "table") return saved;
    return matchMedia("(max-width: 700px)").matches ? "cards" : "table";
  });
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
  const isPhone = matchMedia("(max-width: 1000px)").matches;

  /** Typed text is a search; a question goes to the AI when it's on, which turns it into filters. */
  const submit = () => {
    const t = text.trim();
    if (appStatus?.ai && t && looksLikeQuestion(t)) void interpret();
    else update((p) => { if (t) p.set("q", t); else p.delete("q"); p.delete("agg"); });
  };

  const removeComponent = (k: string) => update((p) => { p.delete("c"); components.filter((x) => x !== k).forEach((x) => p.append("c", x)); });
  const year = new Date().getFullYear();
  const datePresets: Array<[string, string, string]> = [
    ["This year", `${year}-01-01`, `${year}-12-31`],
    ["Last year", `${year - 1}-01-01`, `${year - 1}-12-31`],
    ["Last 90 days", new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10), ""],
  ];
  const dateLabel = datePresets.find(([, f, t]) => f === from && t === to)?.[0] ?? (from && to ? `${from} – ${to}` : from ? `from ${from}` : `until ${to}`);

  // Peek: the selected row's details beside the table (wide screens).
  const [peekId, setPeekId] = useState<string | null>(null);
  const [peek, setPeek] = useState<DocumentDetail | null>(null);
  useEffect(() => {
    if (!peekId) { setPeek(null); return; }
    let live = true;
    api.getDocument(peekId).then((d) => live && setPeek(d)).catch((e) => toast(e.message, "error"));
    return () => { live = false; };
  }, [peekId, toast]);
  useEffect(() => { if (peekId && !items.some((i) => i.id === peekId)) setPeekId(null); }, [items, peekId]);
  // ↑/↓ move the peek through the rows.
  useEffect(() => {
    if (view !== "table" || isPhone) return;
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName)) return;
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Enter") return;
      if (e.key === "Enter") { if (peekId) navigate(`/documents/${peekId}`); return; }
      e.preventDefault();
      const i = items.findIndex((x) => x.id === peekId);
      const next = items[Math.max(0, Math.min(items.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
      if (next) setPeekId(next.id);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [items, peekId, view, isPhone, navigate]);

  /** One-click edits from the peek ("Mark paid"): saves the document with that value. */
  const quickSet = async (index: number, field: string, value: boolean) => {
    if (!peek) return;
    const draft = structuredClone(peek.current);
    draft.components[index].values[field] = value;
    try {
      await api.saveDocument(peek.id, draft, false);
      setPeek(await api.getDocument(peek.id));
      const r = await api.searchDocuments(query);
      setItems(r.items);
      toast("Saved");
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.toolbar}>
        <form className={styles.search} onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={appStatus?.ai ? 'Search, or ask: "unpaid house bills this year"' : 'Search text, e.g. brake "kingsway auto" -oil'}
            aria-label="Search documents"
          />
          {interpreting && <span className={cx(ui.small, ui.muted, ui.pulse)}>Thinking…</span>}
        </form>
        <button className={styles.filterToggle} onClick={() => setShowFilters((v) => !v)} aria-expanded={showFilters}>
          Filters{filterCount ? ` (${filterCount})` : ""}
        </button>
        <div className={cx(styles.chips, showFilters && styles.chipsOpen)}>
          {components.map((k) => (
            <span key={k} className={cx(ui.chip, styles.on)}>
              <Dot color={catalog.find((c) => c.key === k)?.color} />{catalog.find((c) => c.key === k)?.name ?? k}
              <button className={styles.x} onClick={() => removeComponent(k)} aria-label="Remove filter">✕</button>
            </span>
          ))}
          {where.map((w, i) => (
            <span key={w} className={cx(ui.chip, styles.on)}>
              {describeWhere(w, catalog, objects)}
              <button className={styles.x} onClick={() => update((p) => { p.delete("w"); where.filter((_, j) => j !== i).forEach((x) => p.append("w", x)); })} aria-label="Remove filter">✕</button>
            </span>
          ))}
          {ref && (
            <span className={cx(ui.chip, styles.on)}>
              Linked: {objects.find((o) => o.id === ref)?.title ?? "an object"}
              <button className={styles.x} onClick={() => update((p) => p.delete("ref"))} aria-label="Remove filter">✕</button>
            </span>
          )}
          {(from || to) && (
            <span className={cx(ui.chip, styles.on)}>
              {dateLabel}
              <button className={styles.x} onClick={() => update((p) => { p.delete("from"); p.delete("to"); })} aria-label="Remove filter">✕</button>
            </span>
          )}
          <details className={ui.menuWrap} ref={filterMenu}>
            <summary className={cx(ui.chip, styles.add)}>+ Filter</summary>
            <div className={cx(ui.menu, styles.filterMenu)}>
              <div className={styles.menuSection}>
                <div className={styles.menuLabel}>Has component</div>
                <div className={ui.badges}>
                  {catalog.filter((c) => (c.documentUsage ?? 1) > 0 && !components.includes(c.key)).map((c) => (
                    <button key={c.key} className={cx(ui.chip, styles.pickChip)} onClick={() => update((p) => p.append("c", c.key))}>
                      <Dot color={c.color} />{c.name}
                    </button>
                  ))}
                </div>
              </div>
              <div className={styles.menuSection}>
                <div className={styles.menuLabel}>Linked to</div>
                <select className={ui.compact} value={ref} onChange={(e) => update((p) => (e.target.value ? p.set("ref", e.target.value) : p.delete("ref")))}>
                  <option value="">Any object</option>
                  {objects.map((o) => <option key={o.id} value={o.id}>{o.title}</option>)}
                </select>
              </div>
              <div className={styles.menuSection}>
                <div className={styles.menuLabel}>Document date</div>
                <div className={ui.badges}>
                  {datePresets.map(([label, f, t]) => (
                    <button key={label} className={cx(ui.chip, styles.pickChip)} onClick={() => update((p) => { p.set("from", f); if (t) p.set("to", t); else p.delete("to"); })}>{label}</button>
                  ))}
                </div>
                <div className={styles.dateRow}>
                  <DateInput className={ui.compact} value={from || null} aria-label="From" placeholder="From" onChange={(v) => update((p) => (v ? p.set("from", v) : p.delete("from")))} />
                  <span className={ui.muted}>–</span>
                  <DateInput className={ui.compact} value={to || null} aria-label="To" placeholder="To" onChange={(v) => update((p) => (v ? p.set("to", v) : p.delete("to")))} />
                </div>
              </div>
              <div className={styles.menuSection}>
                <div className={styles.menuLabel}>Field</div>
                <FieldFilterBuilder catalog={catalog} objects={objects} onAdd={(w) => { update((p) => p.append("w", w)); filterMenu.current?.removeAttribute("open"); }} />
              </div>
            </div>
          </details>
          {hasFilters && <button className={cx(ui.link, ui.small)} onClick={() => { setText(""); setParams(new URLSearchParams()); }}>Clear</button>}
        </div>
        <span className={ui.spacer} />
        <select className={ui.compact} value={status} onChange={(e) => update((p) => p.set("status", e.target.value), true)} aria-label="Which documents">
          <option value="filed">Filed</option>
          <option value="inbox">In inbox</option>
          <option value="all">All</option>
        </select>
        <select className={ui.compact} value={sort} onChange={(e) => update((p) => p.set("sort", e.target.value), true)} aria-label="Sort">
          {q && <option value="relevance">Best match</option>}
          <option value="date">Newest first</option>
          <option value="added">Recently added</option>
          <option value="title">Title</option>
        </select>
        <div className={styles.segmented} role="group" aria-label="View">
          <button className={cx(ui.compact, view === "table" && styles.segOn)} onClick={() => setView("table")}>Table</button>
          <button className={cx(ui.compact, view === "cards" && styles.segOn)} onClick={() => setView("cards")}>Cards</button>
        </div>
        {view === "table" && (
          <details className={ui.menuWrap}>
            <summary className={cx(ui.button, ui.compact)}>Columns</summary>
            <div className={cx(ui.menu, styles.columnsList)}>
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
          {exporting ? "Exporting…" : "CSV"}
        </button>
      </div>

      {explanation && (
        <div className={styles.explain}>
          <span className={ui.aiMark}>AI</span>
          <span>Read as: {explanation}{warnings.length > 0 && <span className={ui.muted}> {warnings.join(" ")}</span>}</span>
          <span className={ui.spacer} />
          <button className={cx(ui.link, ui.small)} onClick={() => { const p = new URLSearchParams(); p.set("q", text); setParams(p); }}>Search the words instead</button>
        </div>
      )}

      {agg && aggResult && <AggregatePanel result={aggResult} onRemove={() => update((p) => p.delete("agg"), true)} />}

      <div className={cx(styles.body, view === "table" && peekId && !isPhone && styles.withPeek)}>
        <div className={styles.results}>
          <p className={cx(ui.muted, ui.small, styles.count)}>
            {loading ? "Searching…" : `${total} document${total === 1 ? "" : "s"}`}
            {q && appStatus?.semantic.available && (
              <label className={cx(ui.inline, styles.meaningToggle)} title="Also find documents that match by meaning, not just by words">
                <input type="checkbox" checked={semantic} onChange={(e) => update((p) => (e.target.checked ? p.delete("sem") : p.set("sem", "0")), true)} />
                match by meaning{q && semantic && !usedSemantic && !loading ? " (unavailable right now)" : ""}
              </label>
            )}
          </p>
          {view === "table" ? (
            <DocumentTable
              items={items}
              columns={columns}
              catalog={catalog}
              objects={objects}
              total={total}
              groupByYear={sort === "date"}
              selectedId={peekId}
              onSelect={isPhone ? undefined : (id) => setPeekId(id === peekId ? null : id)}
            />
          ) : (
            <div className={styles.grid}>
              {items.map((d) => (
                <Link key={d.id} to={`/documents/${d.id}`} className={styles.card}>
                  {d.hasThumb ? <img className={styles.cardThumb} src={thumbUrl(d.id)} alt="" loading="lazy" /> : <div className={cx(ui.thumbPlaceholder, ui.thumbPlaceholderLarge)}>{d.mimeType.split("/")[1]}</div>}
                  <div className={styles.cardBody}>
                    <div className={styles.cardTitle}>{d.title}</div>
                    <div className={cx(ui.muted, ui.small)}>{d.documentDate ?? "no date"}</div>
                    <div className={ui.badges}>
                      {d.components.map((k, i) => <ComponentChip key={i} componentKey={k} catalog={catalog} />)}
                    </div>
                    {d.match === "meaning" && <div className={cx(styles.matchNote, ui.small)}>Similar meaning; the words don't appear</div>}
                    {d.snippet && <div className={styles.snippet} dangerouslySetInnerHTML={{ __html: sanitizeSnippet(d.snippet) }} />}
                  </div>
                </Link>
              ))}
            </div>
          )}
          {items.length < total && <button className={styles.more} onClick={loadMore}>Load more</button>}
        </div>
        {view === "table" && peekId && !isPhone && (
          <aside className={styles.peek} aria-label="Selected document">
            {peek ? (
              <>
                <div className={styles.peekThumb}>
                  {peek.hasThumb ? <img src={thumbUrl(peek.id)} alt="" /> : <span className={cx(ui.muted, ui.small)}>No preview</span>}
                </div>
                <div className={styles.peekHead}>
                  <div className={styles.peekTitle}>{peek.current.title}</div>
                  <div className={cx(ui.small, ui.muted)}>{peek.current.documentDate ?? "No date"} · {peek.originalFilename}</div>
                </div>
                <div className={styles.peekBody}>
                  <DraftView components={peek.current.components} catalog={catalog} objects={objects} onSet={quickSet} />
                </div>
                <div className={styles.peekActions}>
                  <Link className={cx(ui.button, ui.compact, ui.primary)} to={`/documents/${peek.id}`}>Open</Link>
                  <button className={ui.compact} onClick={() => setPeekId(null)}>Close</button>
                  <span className={cx(ui.small, ui.muted)}>↑↓ to move · Enter to open</span>
                </div>
              </>
            ) : <p className={cx(ui.muted, ui.pad)}>Loading…</p>}
          </aside>
        )}
      </div>
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

/** "Invoice › Total ≥ 100" for a where-filter string "invoice.total:gte:100". */
function describeWhere(w: string, catalog: ComponentDef[], objects: ObjectSummary[]): string {
  const m = /^([^.]+)\.([^:]+):([^:]+)(?::(.*))?$/s.exec(w);
  if (!m) return w;
  const c = catalog.find((x) => x.key === m[1]);
  const f = c?.fields.find((x) => x.key === m[2]);
  const opLabel = f ? opsFor(f.type).find(([o]) => o === m[3])?.[1] ?? m[3] : m[3];
  const v =
    f?.type === "ref" ? objects.find((o) => o.id === m[4])?.title ?? m[4] :
    f?.type === "boolean" ? (m[4] === "true" ? "Yes" : m[4] === "false" ? "No" : m[4]) :
    m[4];
  return `${f ? f.label : `${m[1]}.${m[2]}`} ${opLabel} ${v ?? ""}`.trim();
}

/** Builds one field filter: field, operator, value. */
function FieldFilterBuilder(props: { onAdd: (w: string) => void; catalog: ComponentDef[]; objects: ObjectSummary[] }) {
  const { catalog, objects } = props;
  const fields = catalog.flatMap((c) => c.fields.map((f) => ({ c, f, path: `${c.key}.${f.key}` })));
  const [path, setPath] = useState("");
  const sel = fields.find((x) => x.path === path);
  const [op, setOp] = useState("");
  const [val, setVal] = useState("");
  const ops = sel ? opsFor(sel.f.type) : [];
  const o = op || ops[0]?.[0];
  return (
    <div className={styles.builder}>
      <select className={ui.compact} value={path} onChange={(e) => { setPath(e.target.value); setOp(""); setVal(""); }} aria-label="Field">
        <option value="">Choose a field…</option>
        {catalog.filter((c) => c.fields.length).map((c) => (
          <optgroup key={c.key} label={c.name}>
            {c.fields.map((f) => <option key={f.key} value={`${c.key}.${f.key}`}>{f.label}</option>)}
          </optgroup>
        ))}
      </select>
      {sel && (
        <>
          <select className={ui.compact} value={o} onChange={(e) => setOp(e.target.value)} aria-label="Condition">
            {ops.map(([x, l]) => <option key={x} value={x}>{l}</option>)}
          </select>
          {!["set", "empty"].includes(o) && (
            sel.f.type === "boolean" ? (
              <select className={ui.compact} value={val} onChange={(e) => setVal(e.target.value)} aria-label="Value"><option value="">—</option><option value="true">Yes</option><option value="false">No</option></select>
            ) : sel.f.type === "ref" ? (
              <select className={ui.compact} value={val} onChange={(e) => setVal(e.target.value)} aria-label="Value">
                <option value="">—</option>
                {objects.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}
              </select>
            ) : sel.f.type === "select" ? (
              <select className={ui.compact} value={val} onChange={(e) => setVal(e.target.value)} aria-label="Value">
                <option value="">—</option>
                {(sel.f.options.choices ?? []).map((c) => <option key={c}>{c}</option>)}
              </select>
            ) : (
              <input className={ui.compact} placeholder={sel.f.type === "date" ? "YYYY-MM-DD" : "Value"} value={val} onChange={(e) => setVal(e.target.value)} aria-label="Value" />
            )
          )}
          <button className={cx(ui.compact, ui.primary)} onClick={() => { props.onAdd(["set", "empty"].includes(o) ? `${path}:${o}` : `${path}:${o}:${val}`); setPath(""); }}>Add</button>
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
