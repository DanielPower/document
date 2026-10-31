import { useMemo } from "react";
import type { ComponentDef, ComponentInput, Draft, DraftComponent, DraftValue, FieldDef, ObjectSummary } from "../types";
import { cx } from "../cx";
import { migrateComponentValues } from "../migrateValues";
import ui from "../ui.module.css";
import { ComponentDefEditor } from "./ComponentDefEditor";
import styles from "./DraftEditor.module.css";

type Def = Pick<ComponentDef, "key" | "name" | "color" | "description"> & { fields: Array<Omit<FieldDef, "id" | "position">>; isNew?: boolean };

function defsFor(catalog: ComponentDef[], draft: Draft): Map<string, Def> {
  const m = new Map<string, Def>(catalog.map((c) => [c.key, c]));
  for (const nc of draft.newComponents) {
    if (!m.has(nc.key)) m.set(nc.key, { ...nc, color: nc.color ?? "#6b7280", isNew: true });
  }
  return m;
}

/** Existing objects ordered by how many words their titles share with `title`. */
function likelyMatches(title: string, objects: ObjectSummary[]): ObjectSummary[] {
  const words = new Set(title.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const score = (o: ObjectSummary) => (o.title.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => words.has(w)).length;
  return [...objects].sort((a, b) => score(b) - score(a) || a.title.localeCompare(b.title));
}

let tempCounter = 0;
const newTempId = () => `obj${Date.now().toString(36)}${tempCounter++}`;

/**
 * Edits a Draft: title, date, attached components and their values, plus any
 * component definitions and objects the draft will create when applied.
 */
export function DraftEditor(props: {
  draft: Draft;
  onChange: (d: Draft) => void;
  catalog: ComponentDef[];
  objects: ObjectSummary[];
  showDate?: boolean;
  /** id of the entity being edited, excluded from ref pickers */
  selfId?: string;
  /** The owner says a proposed new object is an existing one. */
  onSameAs?: (tempId: string, objectId: string) => void;
}) {
  const { draft, onChange, catalog } = props;
  const defs = useMemo(() => defsFor(catalog, draft), [catalog, draft]);
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });

  const addNewObject = (title = "New object"): string => {
    const tempId = newTempId();
    onChange({ ...draft, newObjects: [...draft.newObjects, { tempId, title, components: [] }] });
    return tempId;
  };

  /** Removing a proposed component definition also removes its uses. */
  const discardNewComponent = (key: string) => {
    const strip = (cs: DraftComponent[]) => cs.filter((c) => c.component !== key);
    onChange({
      ...draft,
      newComponents: draft.newComponents.filter((c) => c.key !== key),
      components: strip(draft.components),
      newObjects: draft.newObjects.map((o) => ({ ...o, components: strip(o.components) })),
    });
  };

  /** Removing a proposed object also clears refs that point at it. */
  const discardNewObject = (tempId: string) => {
    const ref = `new:${tempId}`;
    const clear = (cs: DraftComponent[]) =>
      cs.map((c) => ({ ...c, values: Object.fromEntries(Object.entries(c.values).map(([k, v]) => [k, v === ref ? null : v])) }));
    onChange({
      ...draft,
      newObjects: draft.newObjects.filter((o) => o.tempId !== tempId).map((o) => ({ ...o, components: clear(o.components) })),
      components: clear(draft.components),
    });
  };

  const ctx: ListCtx = {
    defs,
    objects: props.objects,
    newObjects: draft.newObjects,
    selfId: props.selfId,
    onCreateObject: (title, setRef) => {
      // Create the object and point the ref at it in one state update.
      const tempId = newTempId();
      const withObj = { ...draft, newObjects: [...draft.newObjects, { tempId, title, components: [] }] };
      onChange(setRef(withObj, `new:${tempId}`));
    },
  };

  return (
    <div className={styles.editor}>
      <div className={ui.row}>
        <label className={ui.grow}>
          Title
          <input value={draft.title} onChange={(e) => set({ title: e.target.value })} />
        </label>
        {props.showDate && (
          <label>
            Date
            <input type="date" value={draft.documentDate ?? ""} onChange={(e) => set({ documentDate: e.target.value || null })} />
          </label>
        )}
      </div>

      <ComponentList
        ctx={ctx}
        components={draft.components}
        onChange={(components) => set({ components })}
        withDraft={(cs, d) => ({ ...d, components: cs })}
        draft={draft}
        pickFrom={[...defs.values()]}
      />

      {draft.newComponents.length > 0 && (
        <section className={styles.proposed}>
          <h4>New component definitions</h4>
          <p className={cx(ui.muted, ui.small)}>These will be created when you save. Edit or discard them.</p>
          {draft.newComponents.map((nc, i) => (
            <div className={styles.proposedItem} key={i}>
              <ComponentDefEditor
                value={nc}
                catalog={catalog}
                compact
                onChange={(v: ComponentInput) => {
                  // Keep the values already filled in for this component valid: follow renamed
                  // fields and keys, convert changed types, drop what no longer fits.
                  const rename = (cs: DraftComponent[]) => migrateComponentValues(nc, v, cs);
                  onChange({
                    ...draft,
                    newComponents: draft.newComponents.map((x, j) => (j === i ? v : x)),
                    components: rename(draft.components),
                    newObjects: draft.newObjects.map((o) => ({ ...o, components: rename(o.components) })),
                  });
                }}
              />
              <button className={cx(ui.compact, ui.danger)} onClick={() => discardNewComponent(nc.key)}>Discard “{nc.name}”</button>
            </div>
          ))}
        </section>
      )}

      {draft.newObjects.length > 0 && (
        <section className={styles.proposed}>
          <h4>New objects</h4>
          <p className={cx(ui.muted, ui.small)}>Things this document refers to that don't exist yet. They'll be created when you save.</p>
          {draft.newObjects.map((o, i) => (
            <div className={styles.proposedItem} key={o.tempId}>
              <label>
                Title
                <input
                  value={o.title}
                  onChange={(e) => set({ newObjects: draft.newObjects.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)) })}
                />
              </label>
              {props.onSameAs && (
                <label>
                  Already have it?
                  <select value="" onChange={(e) => e.target.value && props.onSameAs!(o.tempId, e.target.value)}>
                    <option value="">No, create “{o.title}”</option>
                    {likelyMatches(o.title, props.objects).map((x) => (
                      <option key={x.id} value={x.id}>Same as “{x.title}”</option>
                    ))}
                  </select>
                </label>
              )}
              <ComponentList
                ctx={ctx}
                draft={draft}
                components={o.components}
                onChange={(components) => set({ newObjects: draft.newObjects.map((x, j) => (j === i ? { ...x, components } : x)) })}
                withDraft={(cs, d) => ({ ...d, newObjects: d.newObjects.map((x) => (x.tempId === o.tempId ? { ...x, components: cs } : x)) })}
                pickFrom={[...defs.values()]}
              />
              <button className={cx(ui.compact, ui.danger)} onClick={() => discardNewObject(o.tempId)}>Discard “{o.title}”</button>
            </div>
          ))}
        </section>
      )}
      {(draft.objectUpdates?.length ?? 0) > 0 && (
        <section className={styles.proposed}>
          <h4>Changes to existing objects</h4>
          <p className={cx(ui.muted, ui.small)}>Details from this document that will be saved on objects you already have. Blank fields are left as they are.</p>
          {draft.objectUpdates!.map((u, i) => {
            const title = props.objects.find((o) => o.id === u.objectId)?.title ?? "An existing object";
            return (
              <div className={styles.proposedItem} key={u.objectId}>
                <strong>{title}</strong>
                <ComponentList
                  ctx={ctx}
                  draft={draft}
                  components={u.components}
                  onChange={(components) => set({ objectUpdates: draft.objectUpdates!.map((x, j) => (j === i ? { ...x, components } : x)) })}
                  withDraft={(cs, d) => ({ ...d, objectUpdates: (d.objectUpdates ?? []).map((x) => (x.objectId === u.objectId ? { ...x, components: cs } : x)) })}
                  pickFrom={[...defs.values()]}
                />
                <button className={cx(ui.compact, ui.danger)} onClick={() => set({ objectUpdates: draft.objectUpdates!.filter((_, j) => j !== i) })}>
                  Don't change “{title}”
                </button>
              </div>
            );
          })}
        </section>
      )}
      {draft.newObjects.length === 0 && (
        <button className={cx(ui.link, ui.small, styles.newObjectLink)} onClick={() => addNewObject()}>+ Create a new object alongside this</button>
      )}
    </div>
  );
}

interface ListCtx {
  defs: Map<string, Def>;
  objects: ObjectSummary[];
  newObjects: Draft["newObjects"];
  selfId?: string;
  onCreateObject: (title: string, setRef: (d: Draft, ref: string) => Draft) => void;
}

function ComponentList(props: {
  ctx: ListCtx;
  draft: Draft;
  components: DraftComponent[];
  onChange: (cs: DraftComponent[]) => void;
  /** Writes an updated component list into a (possibly newer) draft. */
  withDraft: (cs: DraftComponent[], d: Draft) => Draft;
  pickFrom: Def[];
}) {
  const { ctx, components, onChange } = props;
  const attached = new Set(components.map((c) => c.component));
  return (
    <div className={styles.componentList}>
      {components.map((c, i) => {
        const def = ctx.defs.get(c.component);
        const update = (values: DraftComponent["values"]) => onChange(components.map((x, j) => (j === i ? { ...x, values } : x)));
        return (
          <div className={styles.componentCard} key={i} style={{ borderLeftColor: def?.color ?? "#999" }}>
            <div className={styles.componentCardHead}>
              <span className={styles.componentName}>{def?.name ?? c.component}</span>
              {def?.isNew && <span className={cx(ui.badge, ui.badgeNew)}>new</span>}
              {!def && <span className={cx(ui.badge, ui.badgeWarn)}>unknown component</span>}
              <button className={ui.icon} title="Remove component" onClick={() => onChange(components.filter((_, j) => j !== i))}>✕</button>
            </div>
            {def && def.fields.length > 0 && (
              <div className={styles.fieldGrid}>
                {def.fields.map((f) => (
                  <FieldInput
                    key={f.key}
                    field={f}
                    value={c.values[f.key] ?? null}
                    onChange={(v) => update({ ...c.values, [f.key]: v })}
                    ctx={ctx}
                    onCreateObject={(title) =>
                      ctx.onCreateObject(title, (d, ref) =>
                        props.withDraft(components.map((x, j) => (j === i ? { ...x, values: { ...x.values, [f.key]: ref } } : x)), d),
                      )
                    }
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
      <select
        className={styles.addComponent}
        value=""
        onChange={(e) => e.target.value && onChange([...components, { component: e.target.value, values: {} }])}
      >
        <option value="">+ Add component…</option>
        {props.pickFrom
          .slice()
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((d) => (
            <option key={d.key} value={d.key}>
              {d.name}
              {attached.has(d.key) ? " (again)" : ""}
            </option>
          ))}
      </select>
    </div>
  );
}

function FieldInput(props: {
  field: Omit<FieldDef, "id" | "position">;
  value: DraftValue;
  onChange: (v: DraftValue) => void;
  ctx: ListCtx;
  onCreateObject: (title: string) => void;
}) {
  const { field: f, value, onChange } = props;
  const label = (
    <span title={f.description}>
      {f.label}
      {f.required && <span className={styles.req}>*</span>}
    </span>
  );
  const str = value === null || value === undefined ? "" : String(value);

  let input: React.ReactNode;
  switch (f.type) {
    case "longtext":
      input = <textarea rows={2} value={str} onChange={(e) => onChange(e.target.value || null)} />;
      break;
    case "number":
    case "money":
      input = (
        <div className={styles.withSuffix}>
          <input
            type="number"
            step={f.type === "money" ? "0.01" : "any"}
            value={str}
            onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
          />
          {f.type === "money" && f.options.currency && <span className={styles.suffix}>{f.options.currency}</span>}
        </div>
      );
      break;
    case "date":
      input = <input type="date" value={str} onChange={(e) => onChange(e.target.value || null)} />;
      break;
    case "boolean":
      input = (
        <select value={value === null ? "" : value ? "true" : "false"} onChange={(e) => onChange(e.target.value === "" ? null : e.target.value === "true")}>
          <option value="">—</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      );
      break;
    case "select":
      input = (
        <select value={str} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">—</option>
          {(f.options.choices ?? []).map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      );
      break;
    case "ref": {
      const required = f.options.component;
      const options = props.ctx.objects.filter((o) => o.id !== props.ctx.selfId && (!required || o.components.includes(required)));
      input = (
        <select
          value={str}
          onChange={(e) => {
            if (e.target.value === "__new__") {
              const title = window.prompt("Name of the new object (e.g. “2019 Honda Civic”)");
              if (title?.trim()) props.onCreateObject(title.trim());
              return;
            }
            onChange(e.target.value || null);
          }}
        >
          <option value="">—</option>
          {props.ctx.newObjects.length > 0 && (
            <optgroup label="New (created on save)">
              {props.ctx.newObjects.map((o) => (
                <option key={o.tempId} value={`new:${o.tempId}`}>{o.title}</option>
              ))}
            </optgroup>
          )}
          <optgroup label="Existing">
            {options.map((o) => (
              <option key={o.id} value={o.id} title={o.summary}>{o.title}</option>
            ))}
          </optgroup>
          <option value="__new__">+ New object…</option>
        </select>
      );
      break;
    }
    default:
      input = <input value={str} onChange={(e) => onChange(e.target.value || null)} />;
  }
  return (
    <label className={cx(styles.field, f.type === "longtext" && styles.fieldWide)}>
      {label}
      {input}
    </label>
  );
}
