import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { ComponentDef, ComponentInput, Draft, DraftComponent, DraftObjectUpdate, DraftValue, FieldDef, ObjectSummary } from "../types";
import { cx } from "../cx";
import { migrateComponentValues } from "../migrateValues";
import ui from "../ui.module.css";
import { ComponentDefEditor } from "./ComponentDefEditor";
import { ObjectPicker } from "./ObjectPicker";
import styles from "./DraftEditor.module.css";

type Def = Pick<ComponentDef, "key" | "name" | "color" | "description"> & { fields: Array<Omit<FieldDef, "id" | "position">>; isNew?: boolean };

function defsFor(catalog: ComponentDef[], draft: Draft): Map<string, Def> {
  const m = new Map<string, Def>(catalog.map((c) => [c.key, c]));
  for (const nc of draft.newComponents) {
    if (!m.has(nc.key)) m.set(nc.key, { ...nc, color: nc.color ?? "#6b7280", isNew: true });
  }
  return m;
}

const wordsOf = (s: string) => new Set(s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);

/**
 * Existing objects that a proposed new one might be, best first. An object
 * counts as a likely match when it carries one of the same components and
 * shares at least two words (title or details) with the proposal, e.g. "Honda"
 * and "Civic". The rest follow, those with a shared component first.
 */
export function rankMatches(o: Draft["newObjects"][number], objects: ObjectSummary[]): { likely: ObjectSummary[]; sameKind: ObjectSummary[]; other: ObjectSummary[] } {
  const kinds = new Set(o.components.map((c) => c.component));
  const values = o.components.flatMap((c) => Object.values(c.values)).filter((v) => typeof v === "string" || typeof v === "number");
  const mine = wordsOf(`${o.title} ${values.join(" ")}`);
  const score = (x: ObjectSummary) => [...wordsOf(`${x.title} ${x.summary}`)].filter((w) => mine.has(w)).length;
  const scored = objects
    .map((x) => ({ x, s: score(x), same: x.components.some((k) => kinds.has(k)) }))
    .sort((a, b) => b.s - a.s || a.x.title.localeCompare(b.x.title));
  const likely = scored.filter((r) => r.same && r.s >= 2).map((r) => r.x);
  return {
    likely,
    sameKind: scored.filter((r) => r.same && !likely.includes(r.x)).map((r) => r.x),
    other: scored.filter((r) => !r.same).map((r) => r.x),
  };
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
  /** Offer to create a new object next to the document (intake only). */
  allowNewObjects?: boolean;
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
          {draft.newObjects.map((o, i) => {
            const m = rankMatches(o, props.objects);
            const best = m.likely[0];
            return (
            <div className={styles.proposedItem} key={o.tempId}>
              {props.onSameAs && best && (
                <div className={styles.lookalike}>
                  <div>
                    <strong>Looks like “{best.title}”</strong>, which you already have.
                    {best.summary && <div className={cx(ui.small, ui.muted)}>{best.summary}</div>}
                  </div>
                  <button className={cx(ui.compact, ui.primary)} onClick={() => props.onSameAs!(o.tempId, best.id)}>Use “{best.title}”</button>
                </div>
              )}
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
                    {[["Likely", m.likely], ["Same kind", m.sameKind], ["Other objects", m.other]].map(([label, list]) =>
                      (list as ObjectSummary[]).length ? (
                        <optgroup key={label as string} label={label as string}>
                          {(list as ObjectSummary[]).map((x) => <option key={x.id} value={x.id}>Same as “{x.title}”</option>)}
                        </optgroup>
                      ) : null,
                    )}
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
            );
          })}
        </section>
      )}
      {(draft.objectUpdates?.length ?? 0) > 0 && (
        <section className={styles.proposed}>
          <h4>Changes to existing objects</h4>
          <p className={cx(ui.muted, ui.small)}>Details from this document that will be saved on objects you already have. Nothing else on them changes.</p>
          {draft.objectUpdates!.map((u, i) => (
            <ObjectUpdateCard
              key={u.objectId}
              update={u}
              ctx={ctx}
              onChange={(next) =>
                set({ objectUpdates: next ? draft.objectUpdates!.map((x, j) => (j === i ? next : x)) : draft.objectUpdates!.filter((_, j) => j !== i) })
              }
            />
          ))}
        </section>
      )}
      {props.allowNewObjects && draft.newObjects.length === 0 && (
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
  onCreateObject?: (title: string) => void;
  /** Just the input, without its label. */
  bare?: boolean;
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
        <ObjectPicker
          value={str || null}
          onChange={onChange}
          onCreate={props.onCreateObject}
          options={[
            ...props.ctx.newObjects.map((o) => ({ value: `new:${o.tempId}`, title: o.title, tag: "new" })),
            ...options.map((o) => ({ value: o.id, title: o.title, detail: o.summary })),
          ]}
        />
      );
      break;
    }
    default:
      input = <input value={str} onChange={(e) => onChange(e.target.value || null)} />;
  }
  if (props.bare) return <div className={cx(styles.field, styles.bare)}>{input}</div>;
  return (
    <label className={cx(styles.field, f.type === "longtext" && styles.fieldWide)}>
      {label}
      {input}
    </label>
  );
}

/** Shows a value the way the owner reads it. */
function display(f: Omit<FieldDef, "id" | "position">, v: DraftValue, objects: ObjectSummary[]): string {
  if (v === null || v === undefined || v === "") return "";
  if (f.type === "boolean") return v ? "Yes" : "No";
  if (f.type === "ref") return objects.find((o) => o.id === v)?.title ?? String(v);
  if (f.type === "money" && f.options.currency) return `${v} ${f.options.currency}`;
  return String(v);
}

/**
 * The fields a document will set on an existing object, each as
 * "current → new", so it's clear nothing else on the object changes.
 */
function ObjectUpdateCard(props: {
  update: DraftObjectUpdate;
  ctx: ListCtx;
  onChange: (u: DraftObjectUpdate | null) => void;
}) {
  const { update: u, ctx, onChange } = props;
  const [current, setCurrent] = useState<Draft | null>(null);
  useEffect(() => {
    let live = true;
    api.getObject(u.objectId).then((o) => live && setCurrent(o.current)).catch(() => {});
    return () => { live = false; };
  }, [u.objectId]);
  const title = current?.title ?? ctx.objects.find((o) => o.id === u.objectId)?.title ?? "An existing object";

  const rows = u.components.flatMap((c, ci) => {
    const def = ctx.defs.get(c.component);
    if (!def) return [];
    const now = current?.components.find((x) => x.component === c.component);
    return def.fields
      .filter((f) => c.values[f.key] !== null && c.values[f.key] !== undefined && c.values[f.key] !== "")
      .map((f) => ({ ci, def, f, was: now?.values[f.key] ?? null, value: c.values[f.key] }));
  });

  const setValue = (ci: number, key: string, v: DraftValue | undefined) => {
    const components = u.components
      .map((c, j) => {
        if (j !== ci) return c;
        const values = { ...c.values };
        if (v === undefined) delete values[key];
        else values[key] = v;
        return { ...c, values };
      })
      .filter((c) => Object.values(c.values).some((x) => x !== null && x !== undefined && x !== ""));
    onChange(components.length ? { ...u, components } : null);
  };

  return (
    <div className={styles.proposedItem}>
      <strong>{title}</strong>
      <div className={styles.changes}>
        {rows.map(({ ci, def, f, was, value }) => (
          <div className={styles.change} key={`${ci}.${f.key}`}>
            <div className={styles.changeHead}>
              <span>{def.name} › {f.label}</span>
              <button className={ui.icon} title="Don't change this" onClick={() => setValue(ci, f.key, undefined)}>✕</button>
            </div>
            <div className={styles.changeBody}>
              <span className={cx(ui.small, styles.was)}>{display(f, was, ctx.objects) || <em className={ui.muted}>empty</em>}</span>
              <span className={ui.muted}>→</span>
              <FieldInput field={{ ...f, label: "" }} value={value} ctx={ctx} onChange={(v) => setValue(ci, f.key, v)} bare />
            </div>
          </div>
        ))}
        {!rows.length && <p className={cx(ui.muted, ui.small)}>Nothing left to change.</p>}
      </div>
      <button className={cx(ui.compact, ui.danger)} onClick={() => onChange(null)}>Don't change “{title}”</button>
    </div>
  );
}
