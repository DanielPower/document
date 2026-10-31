import { cx } from "../cx";
import { FIELD_TYPES, type ComponentDef, type ComponentInput, type FieldType } from "../types";
import ui from "../ui.module.css";
import styles from "./ComponentDefEditor.module.css";

export function slugify(s: string): string {
  const k = s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return /^[a-z]/.test(k) ? k : k ? `c_${k}` : "";
}

const TYPE_LABELS: Record<FieldType, string> = {
  text: "Text",
  longtext: "Long text",
  number: "Number",
  money: "Money",
  date: "Date",
  boolean: "Yes / no",
  select: "Choice",
  ref: "Link to object",
};

export function emptyComponent(): ComponentInput {
  return { key: "", name: "", description: "", aiHint: "", color: "#2563eb", fields: [] };
}

/** Edits a component definition (name, guidance for the AI, and its fields). */
export function ComponentDefEditor(props: {
  value: ComponentInput;
  onChange: (v: ComponentInput) => void;
  catalog: ComponentDef[];
  /** Keep the key in sync with the name until the user edits it (new components only). */
  autoKey?: boolean;
  compact?: boolean;
}) {
  const { value: c, onChange, catalog } = props;
  const set = (patch: Partial<ComponentInput>) => onChange({ ...c, ...patch });
  const setField = (i: number, patch: Partial<ComponentInput["fields"][number]>) =>
    set({ fields: c.fields.map((f, j) => (j === i ? { ...f, ...patch } : f)) });
  const move = (i: number, d: number) => {
    const fields = [...c.fields];
    const [f] = fields.splice(i, 1);
    fields.splice(Math.max(0, Math.min(fields.length, i + d)), 0, f);
    set({ fields });
  };

  return (
    <div className={styles.editor}>
      <div className={ui.row}>
        <label className={ui.grow}>
          Name
          <input
            value={c.name}
            onChange={(e) => set({ name: e.target.value, ...(props.autoKey ? { key: slugify(e.target.value) } : {}) })}
            placeholder="Invoice"
          />
        </label>
        <label>
          Key
          <input value={c.key} onChange={(e) => set({ key: e.target.value })} placeholder="invoice" className={ui.mono} />
        </label>
        <label>
          Colour
          <input type="color" value={c.color ?? "#6b7280"} onChange={(e) => set({ color: e.target.value })} />
        </label>
      </div>
      <label>
        Description
        <input value={c.description} onChange={(e) => set({ description: e.target.value })} />
      </label>
      {!props.compact && (
        <label>
          When should the AI attach it?
          <input value={c.aiHint} onChange={(e) => set({ aiHint: e.target.value })} placeholder="Attach to any bill or receipt…" />
        </label>
      )}

      <div className={styles.fieldsHead}>
        <strong>Fields</strong>
        {c.fields.length === 0 && <span className={ui.muted}> — none: this component works as a tag</span>}
      </div>
      {c.fields.map((f, i) => (
        <div className={styles.fieldRow} key={f.id ?? i}>
          <input
            className={ui.grow}
            value={f.label}
            placeholder="Label"
            onChange={(e) => setField(i, { label: e.target.value, ...(!f.id ? { key: slugify(e.target.value) } : {}) })}
          />
          <input className={cx(ui.mono, styles.keyInput)} value={f.key} placeholder="key" onChange={(e) => setField(i, { key: e.target.value })} />
          <select value={f.type} onChange={(e) => setField(i, { type: e.target.value as FieldType, options: {} })}>
            {FIELD_TYPES.map((t) => (
              <option key={t} value={t}>{TYPE_LABELS[t]}</option>
            ))}
          </select>
          {f.type === "select" && (
            <input
              className={ui.grow}
              placeholder="choice 1, choice 2"
              value={(f.options.choices ?? []).join(", ")}
              onChange={(e) => setField(i, { options: { choices: e.target.value.split(",").map((s) => s.trimStart()) } })}
            />
          )}
          {f.type === "money" && (
            <input
              className={styles.currencyInput}
              placeholder="CAD"
              value={f.options.currency ?? ""}
              onChange={(e) => setField(i, { options: { currency: e.target.value.toUpperCase() } })}
            />
          )}
          {f.type === "ref" && (
            <select
              value={f.options.component ?? ""}
              onChange={(e) => setField(i, { options: e.target.value ? { component: e.target.value } : {} })}
              title="Only allow objects that carry this component"
            >
              <option value="">any object</option>
              {catalog.map((cd) => (
                <option key={cd.key} value={cd.key}>with {cd.name}</option>
              ))}
            </select>
          )}
          {(f.type === "text" || f.type === "number") && (
            <label className={ui.inline} title="Identifier: the value pins down exactly one thing (VIN, plate, account number). Objects with the same value are treated as the same object.">
              <input type="checkbox" checked={!!f.options.identifier} onChange={(e) => setField(i, { options: { ...f.options, identifier: e.target.checked || undefined } })} /> ID
            </label>
          )}
          <label className={ui.inline} title="Required">
            <input type="checkbox" checked={f.required} onChange={(e) => setField(i, { required: e.target.checked })} /> req
          </label>
          <button className={ui.icon} onClick={() => move(i, -1)} disabled={i === 0} title="Move up">↑</button>
          <button className={ui.icon} onClick={() => move(i, 1)} disabled={i === c.fields.length - 1} title="Move down">↓</button>
          <button className={cx(ui.icon, ui.danger)} onClick={() => set({ fields: c.fields.filter((_, j) => j !== i) })} title="Remove field">✕</button>
        </div>
      ))}
      <button
        className={cx(ui.compact, styles.addField)}
        onClick={() => set({ fields: [...c.fields, { key: "", label: "", type: "text", description: "", required: false, options: {} }] })}
      >
        + Add field
      </button>
    </div>
  );
}

/** Converts a stored definition into editable input form. */
export function toInput(c: ComponentDef): ComponentInput {
  return {
    key: c.key,
    name: c.name,
    description: c.description,
    aiHint: c.aiHint,
    color: c.color,
    fields: c.fields.map((f) => ({ id: f.id, key: f.key, label: f.label, type: f.type, description: f.description, required: f.required, options: f.options })),
  };
}

/** Cleans editor state before saving (trims select choices). */
export function cleanInput(c: ComponentInput): ComponentInput {
  return {
    ...c,
    fields: c.fields.map((f) => (f.type === "select" ? { ...f, options: { choices: (f.options.choices ?? []).map((x) => x.trim()).filter(Boolean) } } : f)),
  };
}
