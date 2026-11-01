import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, type DuplicateGroup } from "../api";
import { cx } from "../cx";
import { useAppData } from "../data";
import ui from "../ui.module.css";
import { ComponentDots } from "../components/Chip";
import styles from "./Objects.module.css";

export function ObjectsPage() {
  const { objects, catalog } = useAppData();
  const [filter, setFilter] = useState("");
  const [duplicates, setDuplicates] = useState<DuplicateGroup[]>([]);
  const loadDuplicates = useCallback(() => api.duplicateObjects().then(setDuplicates).catch(() => {}), []);
  useEffect(() => { void loadDuplicates(); }, [loadDuplicates, objects]);
  const shown = objects.filter((o) => !filter || `${o.title} ${o.summary}`.toLowerCase().includes(filter.toLowerCase()));
  /** Grouped by kind: each object under its first component (Vehicle, Property…), in catalog order. */
  const groups = useMemo(() => {
    const by = new Map<string, typeof shown>();
    for (const o of shown) {
      const key = o.components[0] ?? "";
      by.set(key, [...(by.get(key) ?? []), o]);
    }
    const order = (k: string) => (k ? catalog.findIndex((c) => c.key === k) : Infinity);
    return [...by.entries()]
      .sort(([a], [b]) => order(a) - order(b))
      .map(([k, list]) => [k ? catalog.find((c) => c.key === k)?.name ?? k : "Other", list] as const);
  }, [shown, catalog]);
  return (
    <div className={cx(ui.page, styles.page)}>
      <div className={styles.toolbar}>
        <h2 className={styles.heading}>Objects</h2>
        <input placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter objects" />
        <span className={cx(ui.small, ui.muted, styles.blurb)}>Things your documents are about. Details live here once, and documents link to them.</span>
        <span className={ui.spacer} />
        <Link className={cx(ui.button, ui.primary)} to="/objects/new">New object</Link>
      </div>
      {duplicates.length > 0 && (
        <div className={styles.duplicates}>
          <h3>Possible duplicates</h3>
          {duplicates.map((g) => <DuplicateGroupCard key={g.objects.map((o) => o.id).join()} group={g} />)}
        </div>
      )}
      {groups.map(([label, list]) => (
        <section key={label} className={styles.kind}>
          <div className={ui.groupHead}>{label} <span className={styles.n}>{list.length}</span></div>
          <div className={ui.list}>
            {list.map((o) => (
              <Link key={o.id} to={`/objects/${o.id}`} className={cx(ui.listItem, styles.row)}>
                <span className={styles.title}>{o.title}</span>
                <span className={cx(ui.small, ui.muted, styles.summary)}>{o.summary.replace(/^[^:]+:\s*/, "") || "no details"}</span>
                <ComponentDots keys={o.components} catalog={catalog} />
                <span className={cx(ui.small, ui.muted, styles.count)}>{o.documentCount} doc{o.documentCount === 1 ? "" : "s"}</span>
              </Link>
            ))}
          </div>
        </section>
      ))}
      {!shown.length && <p className={ui.muted}>No objects yet. They're created from the inbox when the AI spots one, or here.</p>}
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
