import { Link } from "react-router-dom";
import { cx } from "../cx";
import ui from "../ui.module.css";
import { ComponentChip, Dot, humanizeKey } from "./Chip";
import { formatValue } from "./DocumentTable";
import styles from "./DraftView.module.css";
import type { ComponentDef, DraftComponent, ObjectDetail, ObjectSummary } from "../types";

/**
 * Read-only view of an entity's components: a section per component with
 * its filled-in fields as label/value rows. Links to objects are links.
 * Components without fields (tags) show as chips.
 */
export function DraftView(props: {
  components: DraftComponent[];
  catalog: ComponentDef[];
  objects: ObjectSummary[];
  notes?: string;
  /** Object pages: the document each detail came from. */
  sources?: ObjectDetail["sources"];
  /** Offers a one-click "Mark paid" for yes/no fields that are No or empty. */
  onSet?: (index: number, field: string, value: boolean) => void;
}) {
  const { components, catalog, objects } = props;
  const withFields = components.map((c, i) => ({ c, i })).filter(({ c }) => catalog.find((x) => x.key === c.component)?.fields.length !== 0);
  const tags = components.filter((c) => catalog.find((x) => x.key === c.component)?.fields.length === 0);
  return (
    <div className={styles.view}>
      {tags.length > 0 && (
        <div className={ui.badges}>
          {tags.map((c, i) => <ComponentChip key={i} componentKey={c.component} catalog={catalog} />)}
        </div>
      )}
      {withFields.map(({ c, i }) => {
        const def = catalog.find((x) => x.key === c.component);
        const filled = def?.fields.filter((f) => c.values[f.key] != null && c.values[f.key] !== "") ?? [];
        const toggles = props.onSet ? def?.fields.filter((f) => f.type === "boolean" && !c.values[f.key]) ?? [] : [];
        return (
          <section key={i} className={styles.section}>
            <div className={ui.sectionHead}><Dot color={def?.color} />{def?.name ?? humanizeKey(c.component)}</div>
            {filled.length ? (
              <dl className={ui.kv}>
                {filled.map((f) => {
                  const v = c.values[f.key];
                  const src = props.sources?.find((s) => s.component === c.component && s.field === f.key);
                  const toggle = toggles.includes(f);
                  return (
                    <div key={f.key} className={styles.pair}>
                      <dt>{f.label}</dt>
                      <dd className={cx(f.type === "longtext" && styles.long, (f.type === "money" || f.type === "number") && styles.numeric)}>
                        <span className={cx(f.options.identifier && ui.mono)}>
                          {f.type === "ref"
                            ? <Link to={`/objects/${v}`}>{formatValue(v, f, objects) || "(deleted object)"}</Link>
                            : formatValue(v, f, objects)}
                          {f.type === "money" && f.options.currency && <span className={styles.unit}> {f.options.currency}</span>}
                        </span>
                        {src && <span className={styles.source}>from <Link to={`/documents/${src.documentId}`}>{src.documentTitle}</Link></span>}
                        {toggle && <button className={cx(ui.compact, styles.toggle)} onClick={() => props.onSet!(i, f.key, true)}>Mark {f.label.toLowerCase()}</button>}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            ) : (
              <p className={cx(ui.muted, ui.small, styles.none)}>No details yet.</p>
            )}
          </section>
        );
      })}
      {props.notes && (
        <section className={styles.section}>
          <div className={ui.sectionHead}>Notes</div>
          <p className={styles.notes}>{props.notes}</p>
        </section>
      )}
      {!components.length && !props.notes && <p className={cx(ui.muted, ui.small)}>No components yet.</p>}
    </div>
  );
}
