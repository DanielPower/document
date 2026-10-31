import { useState } from "react";
import { Link } from "react-router-dom";
import { cx } from "../cx";
import { useAppData } from "../data";
import ui from "../ui.module.css";

export function ObjectsPage() {
  const { objects, catalog } = useAppData();
  const [filter, setFilter] = useState("");
  const shown = objects.filter((o) => !filter || `${o.title} ${o.summary}`.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div className={ui.page}>
      <div className={ui.pageHead}>
        <h2>Objects</h2>
        <p className={ui.muted}>Things your documents are about: vehicles, properties, people, accounts. Details live here once, and documents link to them.</p>
        <div className={ui.row}>
          <input placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <Link className={cx(ui.button, ui.primary)} to="/objects/new">New object</Link>
        </div>
      </div>
      <div className={ui.list}>
        {shown.map((o) => (
          <Link key={o.id} to={`/objects/${o.id}`} className={ui.listItem}>
            <div>
              <div className={ui.listTitle}>{o.title}</div>
              <div className={cx(ui.muted, ui.small)}>{o.summary || "no details"}</div>
            </div>
            <div className={ui.badges}>
              {o.components.map((k, i) => {
                const c = catalog.find((x) => x.key === k);
                return <span key={i} className={ui.badge} style={{ background: c?.color }}>{c?.name ?? k}</span>;
              })}
            </div>
            <span className={cx(ui.muted, ui.small)}>{o.documentCount} doc{o.documentCount === 1 ? "" : "s"}</span>
          </Link>
        ))}
        {!shown.length && <p className={ui.muted}>No objects yet. They're created from the inbox when the AI spots one, or here.</p>}
      </div>
    </div>
  );
}
