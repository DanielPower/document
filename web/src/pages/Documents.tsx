import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, thumbUrl } from "../api";
import { useAppData } from "../data";
import type { ComponentDef, DocumentSummary, ObjectSummary } from "../types";

const OPS_BY_TYPE: Record<string, Array<[string, string]>> = {
  number: [["eq", "="], ["gt", ">"], ["gte", "≥"], ["lt", "<"], ["lte", "≤"], ["set", "has value"], ["empty", "is empty"]],
  date: [["eq", "on"], ["gte", "on/after"], ["lte", "on/before"], ["set", "has value"], ["empty", "is empty"]],
  boolean: [["eq", "is"]],
  text: [["contains", "contains"], ["eq", "is"], ["set", "has value"], ["empty", "is empty"]],
  ref: [["eq", "is"], ["set", "has value"], ["empty", "is empty"]],
};
const opsFor = (type: string) => OPS_BY_TYPE[type === "money" ? "number" : type === "longtext" || type === "select" ? "text" : type] ?? OPS_BY_TYPE.text;

/** Search state lives in the URL so searches can be bookmarked. */
export function DocumentsPage() {
  const { catalog, objects, toast } = useAppData();
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const components = params.getAll("c");
  const where = params.getAll("w");
  const status = params.get("status") ?? "filed";
  const ref = params.get("ref") ?? "";
  const sort = params.get("sort") ?? (q ? "relevance" : "date");
  const [text, setText] = useState(q);
  const [items, setItems] = useState<DocumentSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  const update = (mut: (p: URLSearchParams) => void) => {
    const p = new URLSearchParams(params);
    mut(p);
    setParams(p, { replace: true });
  };

  const query = useMemo(
    () => ({
      q,
      component: components,
      where,
      ref: ref || undefined,
      status: status === "all" ? undefined : [status],
      sort,
      limit: 60,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [params.toString()],
  );

  useEffect(() => {
    setLoading(true);
    api.searchDocuments(query)
      .then((r) => { setItems(r.items); setTotal(r.total); })
      .catch((e) => toast(e.message, "error"))
      .finally(() => setLoading(false));
  }, [query, toast]);

  const loadMore = async () => {
    const r = await api.searchDocuments({ ...query, offset: items.length });
    setItems([...items, ...r.items]);
  };

  return (
    <div className="page documents">
      <form className="searchbar" onSubmit={(e) => { e.preventDefault(); update((p) => (text ? p.set("q", text) : p.delete("q"))); }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder='Search text, e.g. brake "kingsway auto" -oil' autoFocus />
        <select value={status} onChange={(e) => update((p) => p.set("status", e.target.value))}>
          <option value="filed">Filed</option>
          <option value="inbox">In inbox</option>
          <option value="all">All</option>
        </select>
        <select value={sort} onChange={(e) => update((p) => p.set("sort", e.target.value))}>
          {q && <option value="relevance">Best match</option>}
          <option value="date">Document date</option>
          <option value="added">Recently added</option>
          <option value="title">Title</option>
        </select>
        <button className="primary">Search</button>
      </form>

      <div className="filters">
        <span className="muted small">Has:</span>
        {catalog.map((c) => {
          const on = components.includes(c.key);
          return (
            <button
              key={c.key}
              className={`chip ${on ? "on" : ""}`}
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
      </div>

      <FieldFilters
        catalog={catalog}
        objects={objects}
        where={where}
        onChange={(w) => update((p) => { p.delete("w"); w.forEach((x) => p.append("w", x)); })}
      />

      <p className="muted small">{loading ? "Searching…" : `${total} document${total === 1 ? "" : "s"}`}</p>
      <div className="grid">
        {items.map((d) => (
          <Link key={d.id} to={`/documents/${d.id}`} className="card">
            {d.hasThumb ? <img src={thumbUrl(d.id)} alt="" loading="lazy" /> : <div className="thumb-ph big">{d.mimeType.split("/")[1]}</div>}
            <div className="card-body">
              <div className="title">{d.title}</div>
              <div className="muted small">{d.documentDate ?? "no date"}</div>
              <div className="badges">
                {d.components.map((k, i) => {
                  const c = catalog.find((x) => x.key === k);
                  return <span key={i} className="badge" style={{ background: c?.color }}>{c?.name ?? k}</span>;
                })}
              </div>
              {d.snippet && <div className="snippet" dangerouslySetInnerHTML={{ __html: sanitizeSnippet(d.snippet) }} />}
            </div>
          </Link>
        ))}
      </div>
      {items.length < total && <button onClick={loadMore}>Load more</button>}
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
    const v = x?.f.type === "ref" ? objects.find((o) => o.id === m[4])?.title ?? m[4] : m[4];
    return `${x ? `${x.c.name} › ${x.f.label}` : `${m[1]}.${m[2]}`} ${opLabel} ${v ?? ""}`;
  };
  return (
    <div className="filters">
      {props.where.map((w, i) => (
        <span key={i} className="chip on dark">
          {describe(w)} <button className="icon" onClick={() => props.onChange(props.where.filter((_, j) => j !== i))}>✕</button>
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
            className="small"
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
