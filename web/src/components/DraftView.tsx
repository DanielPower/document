import { Link } from "react-router-dom";
import { cx } from "../cx";
import ui from "../ui.module.css";
import { formatValue } from "./DocumentTable";
import styles from "./DraftView.module.css";
import type { ComponentDef, DraftComponent, ObjectSummary } from "../types";

/**
 * Read-only view of an entity's components: one card per component with its
 * filled-in fields. Links to objects are links. Components without fields
 * (tags) show as badges.
 */
export function DraftView(props: { components: DraftComponent[]; catalog: ComponentDef[]; objects: ObjectSummary[]; notes?: string }) {
  const { components, catalog, objects } = props;
  const withFields = components.filter((c) => catalog.find((x) => x.key === c.component)?.fields.length !== 0);
  const tags = components.filter((c) => catalog.find((x) => x.key === c.component)?.fields.length === 0);
  return (
    <div className={styles.view}>
      {tags.length > 0 && (
        <div className={ui.badges}>
          {tags.map((c, i) => {
            const def = catalog.find((x) => x.key === c.component);
            return <span key={i} className={ui.badge} style={{ background: def?.color }}>{def?.name ?? c.component}</span>;
          })}
        </div>
      )}
      <div className={styles.cards}>
        {withFields.map((c, i) => {
          const def = catalog.find((x) => x.key === c.component);
          const filled = def?.fields.filter((f) => c.values[f.key] != null && c.values[f.key] !== "") ?? [];
          return (
            <section key={i} className={styles.card} style={{ borderLeftColor: def?.color }}>
              <h4>{def?.name ?? c.component}</h4>
              {filled.length ? (
                <dl className={styles.fields}>
                  {filled.map((f) => (
                    <div key={f.key} className={cx(f.type === "longtext" && styles.wide)}>
                      <dt>{f.label}</dt>
                      <dd>
                        {f.type === "ref"
                          ? <Link to={`/objects/${c.values[f.key]}`}>{formatValue(c.values[f.key], f, objects) || "(deleted object)"}</Link>
                          : formatValue(c.values[f.key], f, objects)}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className={cx(ui.muted, ui.small)}>No details yet.</p>
              )}
            </section>
          );
        })}
        {props.notes && (
          <section className={styles.card}>
            <h4>Notes</h4>
            <p className={styles.notes}>{props.notes}</p>
          </section>
        )}
      </div>
      {!components.length && !props.notes && <p className={cx(ui.muted, ui.small)}>No components yet.</p>}
    </div>
  );
}
