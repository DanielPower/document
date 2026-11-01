import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "../api";
import type { ComponentDef, ComponentInput, Draft, DraftComponent, DraftObjectUpdate, DraftValue, FieldDef, ObjectSummary } from "../types";
import { cx } from "../cx";
import { migrateComponentValues } from "../migrateValues";
import { needlesFor } from "../provenance";
import ui from "../ui.module.css";
import { Dot, humanizeKey } from "./Chip";
import { ComponentDefEditor, TYPE_LABELS } from "./ComponentDefEditor";
import { DateInput, NumberInput, quietClass } from "./FieldInputs";
import { ObjectPicker } from "./ObjectPicker";
import styles from "./DraftEditor.module.css";

type Def = Pick<ComponentDef, "key" | "name" | "color" | "description"> & { fields: Array<Omit<FieldDef, "id" | "position">>; isNew?: boolean };
type Field = Omit<FieldDef, "id" | "position">;

export function defsFor(catalog: ComponentDef[], draft: Draft): Map<string, Def> {
  const m = new Map<string, Def>(catalog.map((c) => [c.key, c]));
  for (const nc of draft.newComponents) {
    if (!m.has(nc.key)) m.set(nc.key, { ...nc, color: nc.color ?? "#6b7280", isNew: true });
  }
  return m;
}

const wordsOf = (s: string) => new Set(s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
const isEmpty = (v: DraftValue | undefined) => v === null || v === undefined || v === "";

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

/** How a value got its current state, shown as a small marker next to it. */
export interface ValueMark {
  kind: "inferred" | "you" | "revised";
  note?: string;
}

/**
 * Edits a Draft: title, date, attached components and their values, plus
 * what saving it does besides (component definitions and objects it creates,
 * values it sets on existing objects), listed under "When you file/save".
 *
 * Values are label/value rows whose inputs read as text until pointed at, so
 * the same view serves for reading a proposal and for correcting it.
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
  /**
   * Inbox review: the title and date are shown by the caller, empty optional
   * fields fold into one line, and "When you file" always lists what filing does.
   */
  review?: boolean;
  /** Marker for a value of the draft's own components; path is "c<index>.<field key>". */
  markFor?: (path: string) => ValueMark | undefined;
  /** Pointing at or editing a value: the strings to find it by in the document (empty to clear). */
  onLocate?: (needles: string[]) => void;
}) {
  const { draft, onChange, catalog, review } = props;
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
    fold: !!review,
    onLocate: props.onLocate,
    onCreateObject: (title, setRef) => {
      // Create the object and point the ref at it in one state update.
      const tempId = newTempId();
      const withObj = { ...draft, newObjects: [...draft.newObjects, { tempId, title, components: [] }] };
      onChange(setRef(withObj, `new:${tempId}`));
    },
  };

  const hasEffects = draft.newComponents.length + draft.newObjects.length + (draft.objectUpdates?.length ?? 0) > 0;
  const fileAs = draft.components.map((c) => defs.get(c.component)?.name ?? humanizeKey(c.component));

  return (
    <div className={styles.editor}>
      {!review && (
        <dl className={ui.kv}>
          <dt>Title</dt>
          <dd><input className={quietClass} value={draft.title} onChange={(e) => set({ title: e.target.value })} placeholder="Title" /></dd>
          {props.showDate && (
            <>
              <dt>Date</dt>
              <dd><DateInput quiet value={draft.documentDate} onChange={(v) => set({ documentDate: v })} /></dd>
            </>
          )}
        </dl>
      )}

      <ComponentList
        ctx={ctx}
        components={draft.components}
        onChange={(components) => set({ components })}
        withDraft={(cs, d) => ({ ...d, components: cs })}
        draft={draft}
        pickFrom={[...defs.values()]}
        markFor={props.markFor}
      />

      {(review || hasEffects) && (
        <section className={styles.effects} aria-label={review ? "When you file" : "When you save"}>
          <div className={styles.effectsHead}>{review ? "When you file" : "When you save"}</div>
          {review && (
            <Effect sym="→" kind="link">
              <div>
              File as {fileAs.length ? fileAs.map((n, i) => <span key={i}>{i > 0 && " + "}<b>{n}</b></span>) : <b>a document with no components</b>}
              {draft.documentDate ? <>, dated <span className={ui.mono}>{draft.documentDate}</span></> : ", with no date"}
              </div>
            </Effect>
          )}

          {draft.newComponents.map((nc, i) => (
            <NewComponentEffect
              key={nc.key || i}
              value={nc}
              catalog={catalog}
              onDiscard={() => discardNewComponent(nc.key)}
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
          ))}

          {draft.newObjects.map((o, i) => {
            const m = rankMatches(o, props.objects);
            return (
              <Effect key={o.tempId} sym="+" kind="new">
                <div className={styles.effectLine}>
                  <span>Create object</span>
                  <input
                    className={cx(quietClass, styles.objectTitle)}
                    value={o.title}
                    aria-label="New object's title"
                    onChange={(e) => set({ newObjects: draft.newObjects.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)) })}
                  />
                  <span className={ui.tagNew}>new</span>
                </div>
                <ComponentList
                  ctx={{ ...ctx, fold: false }}
                  draft={draft}
                  components={o.components}
                  onChange={(components) => set({ newObjects: draft.newObjects.map((x, j) => (j === i ? { ...x, components } : x)) })}
                  withDraft={(cs, d) => ({ ...d, newObjects: d.newObjects.map((x) => (x.tempId === o.tempId ? { ...x, components: cs } : x)) })}
                  pickFrom={[...defs.values()]}
                  nested
                />
                <div className={styles.effectActions}>
                  {props.onSameAs && (
                    <select
                      className={cx(ui.compact, styles.sameAs)}
                      value=""
                      aria-label="Already have it?"
                      onChange={(e) => e.target.value && props.onSameAs!(o.tempId, e.target.value)}
                    >
                      <option value="">Already have it? Link an existing object…</option>
                      {[["Likely", m.likely], ["Same kind", m.sameKind], ["Other objects", m.other]].map(([label, list]) =>
                        (list as ObjectSummary[]).length ? (
                          <optgroup key={label as string} label={label as string}>
                            {(list as ObjectSummary[]).map((x) => <option key={x.id} value={x.id}>Same as “{x.title}”</option>)}
                          </optgroup>
                        ) : null,
                      )}
                    </select>
                  )}
                  <button className={cx(ui.compact, ui.ghost, ui.danger)} onClick={() => discardNewObject(o.tempId)}>Don't create</button>
                </div>
              </Effect>
            );
          })}

          {(draft.objectUpdates ?? []).map((u, i) => (
            <ObjectUpdateEffect
              key={u.objectId}
              update={u}
              ctx={ctx}
              onChange={(next) =>
                set({ objectUpdates: next ? draft.objectUpdates!.map((x, j) => (j === i ? next : x)) : draft.objectUpdates!.filter((_, j) => j !== i) })
              }
            />
          ))}

          {props.allowNewObjects && draft.newObjects.length === 0 && (
            <button className={cx(ui.link, ui.small, styles.newObjectLink)} onClick={() => addNewObject()}>+ Also create an object (a car, a house, an account…)</button>
          )}
        </section>
      )}
    </div>
  );
}

function Effect({ sym, kind, children }: { sym: string; kind: "new" | "change" | "link"; children: ReactNode }) {
  return (
    <div className={styles.effect}>
      <span className={cx(styles.sym, kind === "new" && styles.symNew, kind === "change" && styles.symChange)} aria-hidden="true">{sym}</span>
      <div className={styles.effectBody}>{children}</div>
    </div>
  );
}

/** A component definition filing will create: its fields in one line, the editor on request. */
function NewComponentEffect(props: { value: ComponentInput; catalog: ComponentDef[]; onChange: (v: ComponentInput) => void; onDiscard: () => void }) {
  const [open, setOpen] = useState(false);
  const { value: nc } = props;
  return (
    <Effect sym="+" kind="new">
      <div className={styles.effectLine}>
        <span>New component</span>
        <Dot color={nc.color} />
        <b>{nc.name || nc.key}</b>
        <span className={ui.tagNew}>new</span>
      </div>
      <div className={cx(ui.small, ui.muted)}>
        {nc.fields.length ? nc.fields.map((f) => `${f.label} (${TYPE_LABELS[f.type].toLowerCase()})`).join(" · ") : "A tag with no fields"}
      </div>
      {open && <div className={styles.defEditor}><ComponentDefEditor value={nc} catalog={props.catalog} compact onChange={props.onChange} /></div>}
      <div className={styles.effectActions}>
        <button className={cx(ui.compact)} onClick={() => setOpen((v) => !v)}>{open ? "Done editing" : "Edit definition"}</button>
        <button className={cx(ui.compact, ui.ghost, ui.danger)} onClick={props.onDiscard}>Don't create</button>
      </div>
    </Effect>
  );
}

interface ListCtx {
  defs: Map<string, Def>;
  objects: ObjectSummary[];
  newObjects: Draft["newObjects"];
  selfId?: string;
  /** Fold empty optional fields into one line. */
  fold: boolean;
  onLocate?: (needles: string[]) => void;
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
  markFor?: (path: string) => ValueMark | undefined;
  /** Inside a new object: lighter headings. */
  nested?: boolean;
}) {
  const { ctx, components, onChange } = props;
  const attached = new Set(components.map((c) => c.component));
  /** Components whose empty fields were unfolded with "add". */
  const [open, setOpen] = useState<Set<number>>(new Set());
  return (
    <div className={cx(styles.componentList, props.nested && styles.nested)}>
      {components.map((c, i) => {
        const def = ctx.defs.get(c.component);
        const update = (values: DraftComponent["values"]) => onChange(components.map((x, j) => (j === i ? { ...x, values } : x)));
        const fields = def?.fields ?? [];
        const folded = ctx.fold && !open.has(i) ? fields.filter((f) => isEmpty(c.values[f.key]) && !f.required) : [];
        const shown = fields.filter((f) => !folded.includes(f));
        return (
          <section className={styles.component} key={i}>
            <div className={ui.sectionHead}>
              <Dot color={def?.color ?? "#999"} />
              <span>{def?.name ?? humanizeKey(c.component)}</span>
              {def?.isNew && <span className={ui.tagNew}>new</span>}
              {!def && <span className={ui.tagWarn}>unknown component</span>}
              <span className={ui.spacer} />
              <button className={ui.icon} title={`Remove ${def?.name ?? "component"}`} onClick={() => onChange(components.filter((_, j) => j !== i))}>✕</button>
            </div>
            {shown.length > 0 && (
              <dl className={cx(ui.kv, styles.fields)}>
                {shown.map((f) => {
                  const v = c.values[f.key] ?? null;
                  const mark = props.markFor?.(`c${i}.${f.key}`);
                  const missing = f.required && isEmpty(v);
                  const locate = () => ctx.onLocate?.(needlesFor(f, v));
                  return (
                    <FieldRow
                      key={f.key}
                      field={f}
                      mark={mark}
                      missing={missing}
                      onLocate={ctx.onLocate ? locate : undefined}
                    >
                      <FieldInput
                        field={f}
                        value={v}
                        onChange={(nv) => update({ ...c.values, [f.key]: nv })}
                        ctx={ctx}
                        onCreateObject={(title) =>
                          ctx.onCreateObject(title, (d, ref) =>
                            props.withDraft(components.map((x, j) => (j === i ? { ...x, values: { ...x.values, [f.key]: ref } } : x)), d),
                          )
                        }
                      />
                    </FieldRow>
                  );
                })}
              </dl>
            )}
            {folded.length > 0 && (
              <div className={styles.empties}>
                {folded.map((f) => f.label).join(", ")}: empty ·{" "}
                <button className={cx(ui.link, ui.small)} onClick={() => setOpen((s) => new Set(s).add(i))}>add</button>
              </div>
            )}
            {def && !fields.length && <div className={styles.empties}>A tag: no fields to fill in.</div>}
          </section>
        );
      })}
      <select
        className={cx(styles.addComponent, ui.compact)}
        value=""
        aria-label="Add a component"
        onChange={(e) => e.target.value && onChange([...components, { component: e.target.value, values: {} }])}
      >
        <option value="">+ Add component</option>
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

const MARK_GLYPH: Record<ValueMark["kind"], string> = { inferred: "≈", you: "you", revised: "rev" };
const MARK_TITLE: Record<ValueMark["kind"], string> = {
  inferred: "The AI inferred this; it isn't written in the document",
  you: "You changed this",
  revised: "Changed by your last request to the AI",
};

const GLYPH_CLASS: Record<ValueMark["kind"], string> = { inferred: styles.glyph_inferred, you: styles.glyph_you, revised: styles.glyph_revised };

/** One label/value row with its provenance marker. */
function FieldRow(props: { field: Field; mark?: ValueMark; missing?: boolean; onLocate?: () => void; children: ReactNode }) {
  const { field: f, mark } = props;
  const cls = cx(
    styles.value,
    mark?.kind === "inferred" && styles.markInferred,
    mark?.kind === "you" && styles.markYou,
    mark?.kind === "revised" && styles.markRevised,
  );
  return (
    <>
      <dt title={f.description || undefined} onMouseEnter={props.onLocate}>
        {f.label}
        {f.required && <span className={styles.req} title="Required">*</span>}
      </dt>
      <dd className={cls} onMouseEnter={props.onLocate} onFocusCapture={props.onLocate}>
        <div className={styles.input}>{props.children}</div>
        {mark && (
          <span className={styles.markNote} title={MARK_TITLE[mark.kind]}>
            <span className={cx(styles.glyph, GLYPH_CLASS[mark.kind])}>{MARK_GLYPH[mark.kind]}</span>
            {mark.note && <span className={styles.note}>{mark.note}</span>}
          </span>
        )}
        {props.missing && !mark && <span className={ui.tagWarn}>required</span>}
      </dd>
    </>
  );
}

function FieldInput(props: {
  field: Field;
  value: DraftValue;
  onChange: (v: DraftValue) => void;
  ctx: ListCtx;
  onCreateObject?: (title: string) => void;
}) {
  const { field: f, value, onChange } = props;
  const str = value === null || value === undefined ? "" : String(value);
  const label = f.label;

  switch (f.type) {
    case "longtext":
      return <textarea className={quietClass} rows={2} value={str} aria-label={label} onChange={(e) => onChange(e.target.value || null)} />;
    case "number":
    case "money":
      return (
        <div className={styles.withSuffix}>
          <NumberInput quiet money={f.type === "money"} value={typeof value === "number" ? value : null} aria-label={label} onChange={onChange} />
          {f.type === "money" && f.options.currency && <span className={styles.suffix}>{f.options.currency}</span>}
        </div>
      );
    case "date":
      return <DateInput quiet value={str || null} aria-label={label} onChange={onChange} />;
    case "boolean":
      return (
        <select className={quietClass} aria-label={label} value={value === null || value === undefined ? "" : value ? "true" : "false"} onChange={(e) => onChange(e.target.value === "" ? null : e.target.value === "true")}>
          <option value="">—</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      );
    case "select":
      return (
        <select className={quietClass} aria-label={label} value={str} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">—</option>
          {(f.options.choices ?? []).map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      );
    case "ref": {
      const required = f.options.component;
      const options = props.ctx.objects.filter((o) => o.id !== props.ctx.selfId && (!required || o.components.includes(required)));
      return (
        <div className={styles.withSuffix}>
        <ObjectPicker
          quiet
          value={str || null}
          onChange={onChange}
          onCreate={props.onCreateObject}
          options={[
            ...props.ctx.newObjects.map((o) => ({ value: `new:${o.tempId}`, title: o.title, tag: "new" })),
            ...options.map((o) => ({ value: o.id, title: o.title, detail: o.summary })),
          ]}
        />
        {str.startsWith("new:") && <span className={ui.tagNew} title="Created when you file">new</span>}
        </div>
      );
    }
    default:
      return <input className={cx(quietClass, f.options.identifier && ui.mono)} aria-label={label} value={str} onChange={(e) => onChange(e.target.value || null)} />;
  }
}

/** Shows a value the way the owner reads it. */
export function display(f: Pick<FieldDef, "type" | "options">, v: DraftValue, objects: ObjectSummary[]): string {
  if (v === null || v === undefined || v === "") return "";
  if (f.type === "boolean") return v ? "Yes" : "No";
  if (f.type === "ref") return objects.find((o) => o.id === v)?.title ?? String(v);
  if (f.type === "money" && typeof v === "number") return `${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${f.options.currency ? ` ${f.options.currency}` : ""}`;
  return String(v);
}

/**
 * The fields a document will set on an existing object, each as
 * "current → new", so it's clear nothing else on the object changes.
 */
function ObjectUpdateEffect(props: {
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
      .filter((f) => !isEmpty(c.values[f.key]))
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
      .filter((c) => Object.values(c.values).some((x) => !isEmpty(x)));
    onChange(components.length ? { ...u, components } : null);
  };

  return (
    <Effect sym="~" kind="change">
      <div className={styles.effectLine}>
        <span>Change</span>
        <b>{title}</b>
        <span className={ui.tagChange}>change</span>
      </div>
      <div className={styles.changes}>
        {rows.map(({ ci, def, f, was, value }) => (
          <div className={styles.change} key={`${ci}.${f.key}`}>
            <span className={styles.changeLabel}>{def.name} › {f.label}</span>
            <span className={styles.was}>{display(f, was, ctx.objects) || <em>empty</em>}</span>
            <span className={ui.muted} aria-hidden="true">→</span>
            <div className={styles.input}>
              <FieldInput field={f} value={value} ctx={ctx} onChange={(v) => setValue(ci, f.key, v)} />
            </div>
            <button className={ui.icon} title="Don't change this" onClick={() => setValue(ci, f.key, undefined)}>✕</button>
          </div>
        ))}
        {!rows.length && <p className={cx(ui.muted, ui.small)}>Nothing left to change.</p>}
      </div>
      <div className={styles.effectActions}>
        <button className={cx(ui.compact, ui.ghost, ui.danger)} onClick={() => onChange(null)}>Don't change “{title}”</button>
      </div>
    </Effect>
  );
}
