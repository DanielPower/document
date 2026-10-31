import { useState } from "react";
import { Link } from "react-router-dom";
import { useAppData } from "../data";

export function ObjectsPage() {
  const { objects, catalog } = useAppData();
  const [filter, setFilter] = useState("");
  const shown = objects.filter((o) => !filter || `${o.title} ${o.summary}`.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div className="page">
      <div className="page-head">
        <h2>Objects</h2>
        <p className="muted">Things your documents are about: vehicles, properties, people, accounts. Details live here once, and documents link to them.</p>
        <div className="row">
          <input placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <Link className="button primary" to="/objects/new">New object</Link>
        </div>
      </div>
      <div className="list">
        {shown.map((o) => (
          <Link key={o.id} to={`/objects/${o.id}`} className="list-item">
            <div>
              <div className="title">{o.title}</div>
              <div className="muted small">{o.summary || "no details"}</div>
            </div>
            <div className="badges">
              {o.components.map((k, i) => {
                const c = catalog.find((x) => x.key === k);
                return <span key={i} className="badge" style={{ background: c?.color }}>{c?.name ?? k}</span>;
              })}
            </div>
            <span className="muted small">{o.documentCount} doc{o.documentCount === 1 ? "" : "s"}</span>
          </Link>
        ))}
        {!shown.length && <p className="muted">No objects yet. They're created from the inbox when the AI spots one, or here.</p>}
      </div>
    </div>
  );
}
