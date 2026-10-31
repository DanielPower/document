import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type DuplicateGroup } from "../api";
import { cx } from "../cx";
import { useAppData } from "../data";
import ui from "../ui.module.css";
import styles from "./Objects.module.css";

export function ObjectsPage() {
  const { objects, catalog } = useAppData();
  const [filter, setFilter] = useState("");
  const [duplicates, setDuplicates] = useState<DuplicateGroup[]>([]);
  const loadDuplicates = useCallback(() => api.duplicateObjects().then(setDuplicates).catch(() => {}), []);
  useEffect(() => { void loadDuplicates(); }, [loadDuplicates, objects]);
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
      {duplicates.length > 0 && (
        <div className={styles.duplicates}>
          <h3>Possible duplicates</h3>
          {duplicates.map((g) => <DuplicateGroupCard key={g.objects.map((o) => o.id).join()} group={g} />)}
        </div>
      )}
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

/** One group of likely duplicates: pick the object to keep, merge the rest into it. */
function DuplicateGroupCard({ group }: { group: DuplicateGroup }) {
  const { refresh, toast } = useAppData();
  // Keep the most-used object by default.
  const [keep, setKeep] = useState(() => [...group.objects].sort((a, b) => b.documentCount - a.documentCount)[0].id);
  const [busy, setBusy] = useState(false);
  const others = group.objects.filter((o) => o.id !== keep);
  const keepTitle = group.objects.find((o) => o.id === keep)?.title;

  const merge = async () => {
    if (!group.certain && !confirm(`These only have similar names. Merge ${others.map((o) => `"${o.title}"`).join(", ")} into "${keepTitle}"?`)) return;
    setBusy(true);
    try {
      const discarded: string[] = [];
      for (const o of others) discarded.push(...(await api.mergeObject(o.id, keep)).discarded);
      toast(`Merged into "${keepTitle}".` + (discarded.length ? ` Kept its values over: ${discarded.join("; ")}.` : ""));
      await refresh();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.group}>
      <div className={styles.groupHead}>
        <strong>{group.certain ? "Same thing" : "Probably the same thing"}</strong>
        <span className={cx(ui.muted, ui.small)}>{group.reason}</span>
      </div>
      {group.objects.map((o) => (
        <label key={o.id} className={styles.choice}>
          <input type="radio" checked={keep === o.id} onChange={() => setKeep(o.id)} />
          <Link to={`/objects/${o.id}`}>{o.title}</Link>
          <span className={cx(ui.muted, ui.small)}>{o.documentCount} doc{o.documentCount === 1 ? "" : "s"}{keep === o.id ? " · keep this one" : ""}</span>
        </label>
      ))}
      <div className={styles.groupActions}>
        <button className={ui.primary} disabled={busy} onClick={merge}>Merge into “{keepTitle}”</button>
        <span className={cx(ui.muted, ui.small)}>Links move over and missing details are filled in; where both have a value, the kept object's wins.</span>
      </div>
    </div>
  );
}
