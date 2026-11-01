import { Link } from "react-router-dom";
import { cx } from "../cx";
import { ComponentDots } from "./Chip";
import styles from "./DocumentTable.module.css";
import type { ComponentDef, DocumentSummary, DraftValue, FieldDef, ObjectSummary } from "../types";

export const money = (v: number) => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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
  if (field.type === "money" && typeof v === "number") return money(v);
  return String(v);
}

/**
 * A date column that reads as a due date ("Due date", "Due") on a document
 * whose yes/no fields aren't Yes (not paid) is overdue once the date passes.
 */
function overdue(d: DocumentSummary, c: Column, v: DraftValue): boolean {
  if (c.field.type !== "date" || !/due/i.test(c.field.label) || typeof v !== "string") return false;
  if (v >= new Date().toISOString().slice(0, 10)) return false;
  const comp = d.values?.find((x) => x.component === c.component.key);
  const flags = c.component.fields.filter((f) => f.type === "boolean").map((f) => comp?.values[f.key]);
  return flags.length > 0 && !flags.some((x) => x === true);
}

/**
 * Documents as rows with chosen field columns, grouped by year with a
 * subtotal per money column, and a total row for what's shown.
 */
export function DocumentTable(props: {
  items: DocumentSummary[];
  columns: Column[];
  catalog: ComponentDef[];
  objects: ObjectSummary[];
  /** How many match in all (the table may show fewer). */
  total: number;
  selectedId?: string | null;
  /** Clicking a row selects it (for a side panel) instead of opening it. */
  onSelect?: (id: string) => void;
  groupByYear?: boolean;
}) {
  const { items, columns, catalog, objects } = props;
  const numeric = (c: Column) => c.field.type === "number" || c.field.type === "money";
  const sums = (rows: DocumentSummary[]) =>
    columns.map((c) => (c.field.type === "money" ? rows.reduce((n, d) => n + (typeof valueAt(d, c.path) === "number" ? (valueAt(d, c.path) as number) : 0), 0) : null));
  const years: Array<{ year: string; rows: DocumentSummary[] }> = [];
  for (const d of items) {
    const y = props.groupByYear ? d.documentDate?.slice(0, 4) ?? "No date" : "";
    const last = years[years.length - 1];
    if (last?.year === y) last.rows.push(d);
    else years.push({ year: y, rows: [d] });
  }
  const anyMoney = columns.some((c) => c.field.type === "money");
  const multipleKinds = new Set(items.flatMap((d) => d.components)).size > 1;
  return (
    <div className={styles.wrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Title</th>
            <th>Date</th>
            {columns.map((c) => (
              <th key={c.path} className={cx(numeric(c) && styles.num)} title={`${c.component.name} › ${c.field.label}`}>
                {c.field.label}
                {c.field.type === "money" && c.field.options.currency && <span className={styles.unit}> {c.field.options.currency}</span>}
              </th>
            ))}
          </tr>
        </thead>
        {years.map((g) => (
          <tbody key={g.year || "all"}>
            {props.groupByYear && (
              <tr className={styles.year}>
                <td colSpan={2}>{g.year} · {g.rows.length} document{g.rows.length === 1 ? "" : "s"}</td>
                {sums(g.rows).map((s, i) => <td key={i} className={styles.num}>{s === null ? "" : money(s)}</td>)}
              </tr>
            )}
            {g.rows.map((d) => (
              <tr
                key={d.id}
                className={cx(props.selectedId === d.id && styles.selected, props.onSelect && styles.clickable)}
                onClick={props.onSelect ? (e) => { if (!(e.target as HTMLElement).closest("a")) props.onSelect!(d.id); } : undefined}
              >
                <td className={styles.title}>
                  {multipleKinds && <ComponentDots keys={d.components} catalog={catalog} />}
                  <Link to={`/documents/${d.id}`} onClick={props.onSelect ? (e) => { e.preventDefault(); props.onSelect!(d.id); } : undefined}>{d.title}</Link>
                </td>
                <td className={styles.nowrap}>{d.documentDate ?? ""}</td>
                {columns.map((c) => {
                  const v = valueAt(d, c.path);
                  const text = formatValue(v, c.field, objects);
                  const late = overdue(d, c, v);
                  return (
                    <td key={c.path} className={cx(numeric(c) && styles.num, late && styles.overdue)}>
                      {c.field.type === "ref" && v ? <Link to={`/objects/${v}`}>{text}</Link> : text}
                      {late && " · overdue"}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        ))}
        {anyMoney && items.length > 0 && (
          <tfoot>
            <tr>
              <td colSpan={2}>{items.length < props.total ? `Sum of the ${items.length} shown (of ${props.total})` : `Sum of ${items.length} document${items.length === 1 ? "" : "s"}`}</td>
              {sums(items).map((s, i) => <td key={i} className={styles.num}>{s === null ? "" : money(s)}</td>)}
            </tr>
          </tfoot>
        )}
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
