import { Link } from "react-router-dom";
import { cx } from "../cx";
import ui from "../ui.module.css";
import styles from "./DocumentTable.module.css";
import type { ComponentDef, DocumentSummary, DraftValue, FieldDef, ObjectSummary } from "../types";

/** A column is a field path, "component.field". */
export interface Column {
  path: string;
  component: ComponentDef;
  field: FieldDef;
}

export function allColumns(catalog: ComponentDef[]): Column[] {
  return catalog.flatMap((c) => c.fields.filter((f) => f.type !== "longtext").map((f) => ({ path: `${c.key}.${f.key}`, component: c, field: f })));
}

/**
 * Columns to show when the owner hasn't picked any: the fields of the
 * components the listed documents use most, up to six.
 */
export function defaultColumns(items: DocumentSummary[], catalog: ComponentDef[]): string[] {
  const uses = new Map<string, number>();
  for (const d of items) for (const k of new Set(d.components)) uses.set(k, (uses.get(k) ?? 0) + 1);
  return [...catalog]
    .filter((c) => uses.has(c.key))
    .sort((a, b) => uses.get(b.key)! - uses.get(a.key)!)
    .flatMap((c) => c.fields.filter((f) => f.type !== "longtext").map((f) => `${c.key}.${f.key}`))
    .slice(0, 6);
}

/** The first value of a field on a document (a component can be attached more than once). */
export function valueAt(d: DocumentSummary, path: string): DraftValue {
  const [component, field] = path.split(".");
  for (const c of d.values ?? []) if (c.component === component && c.values[field] != null) return c.values[field];
  return null;
}

/** A value as text, as a person reads it. */
export function formatValue(v: DraftValue, field: FieldDef, objects: ObjectSummary[]): string {
  if (v === null || v === undefined) return "";
  if (field.type === "boolean") return v ? "Yes" : "No";
  if (field.type === "ref") return objects.find((o) => o.id === v)?.title ?? "";
  if (field.type === "money" && typeof v === "number") return v.toFixed(2);
  return String(v);
}

export function DocumentTable(props: {
  items: DocumentSummary[];
  columns: Column[];
  catalog: ComponentDef[];
  objects: ObjectSummary[];
}) {
  const { items, columns, catalog, objects } = props;
  const numeric = (c: Column) => c.field.type === "number" || c.field.type === "money";
  return (
    <div className={styles.wrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Title</th>
            <th>Date</th>
            {columns.map((c) => (
              <th key={c.path} className={cx(numeric(c) && styles.num)} title={c.component.name}>
                {c.field.label}
                {c.field.type === "money" && c.field.options.currency && <span className={styles.unit}> {c.field.options.currency}</span>}
              </th>
            ))}
            <th>Components</th>
          </tr>
        </thead>
        <tbody>
          {items.map((d) => (
            <tr key={d.id}>
              <td className={styles.title}><Link to={`/documents/${d.id}`}>{d.title}</Link></td>
              <td className={styles.nowrap}>{d.documentDate ?? ""}</td>
              {columns.map((c) => {
                const v = valueAt(d, c.path);
                const text = formatValue(v, c.field, objects);
                return (
                  <td key={c.path} className={cx(numeric(c) && styles.num)}>
                    {c.field.type === "ref" && v ? <Link to={`/objects/${v}`}>{text}</Link> : text}
                  </td>
                );
              })}
              <td>
                <div className={ui.badges}>
                  {d.components.map((k, i) => {
                    const c = catalog.find((x) => x.key === k);
                    return <span key={i} className={ui.badge} style={{ background: c?.color }}>{c?.name ?? k}</span>;
                  })}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Builds a CSV of the documents with the given columns. */
export function toCsv(items: DocumentSummary[], columns: Column[], catalog: ComponentDef[], objects: ObjectSummary[]): string {
  const cell = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const head = ["Title", "Date", "Status", ...columns.map((c) => `${c.component.name} ${c.field.label}`), "Components", "Link"];
  const rows = items.map((d) => [
    d.title,
    d.documentDate ?? "",
    d.status,
    ...columns.map((c) => formatValue(valueAt(d, c.path), c.field, objects)),
    d.components.map((k) => catalog.find((x) => x.key === k)?.name ?? k).join("; "),
    `${location.origin}/documents/${d.id}`,
  ]);
  return [head, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}
