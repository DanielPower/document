import { useState } from "react";
import { api } from "../api";
import { cleanInput, ComponentDefEditor, emptyComponent, toInput } from "../components/ComponentDefEditor";
import { cx } from "../cx";
import { useAppData } from "../data";
import ui from "../ui.module.css";
import { Dot } from "../components/Chip";
import styles from "./Components.module.css";
import type { ComponentInput } from "../types";

export function ComponentsPage() {
  const { catalog, refresh, toast, status } = useAppData();
  const [editing, setEditing] = useState<{ id: string | null; value: ComponentInput; notes?: string } | null>(null);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await fn();
      if (done) toast(done);
      return true;
    } catch (e) {
      toast((e as Error).message, "error");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!editing) return;
    const v = cleanInput(editing.value);
    const ok = await run(() => (editing.id ? api.updateComponent(editing.id, v) : api.createComponent(v)), "Saved");
    if (ok) { setEditing(null); await refresh(); }
  };

  const remove = async () => {
    if (!editing?.id) return;
    const usage = catalog.find((c) => c.id === editing.id)?.usage ?? 0;
    const msg = usage
      ? `"${editing.value.name}" is attached to ${usage} item(s). Deleting it removes it and its values from all of them. Continue?`
      : `Delete "${editing.value.name}"?`;
    if (!confirm(msg)) return;
    if (await run(() => api.deleteComponent(editing.id!, usage > 0), "Deleted")) { setEditing(null); await refresh(); }
  };

  const generate = async () => {
    await run(async () => {
      const r = await api.generateComponent(prompt);
      setEditing({ id: null, value: { ...r.component, color: "#2563eb" }, notes: r.notes });
    });
  };

  return (
    <div className={ui.page}>
      <div className={ui.pageHead}>
        <h2>Components</h2>
        <p className={ui.muted}>
          Reusable groups of fields. Attach any combination to documents and objects. A component with no fields works as a tag.
        </p>
      </div>
      <div className={styles.layout}>
        <div className={styles.side}>
          <div className={styles.tools}>
          <button className={ui.primary} onClick={() => setEditing({ id: null, value: emptyComponent() })}>New component</button>
          {status?.ai && (
            <div className={styles.generate}>
              <textarea
                rows={2}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Describe a component and let AI draft it, e.g. “home insurance policy with renewal date and premium”"
              />
              <button disabled={busy || prompt.trim().length < 3} onClick={generate}>{busy ? "Working…" : "Generate with AI"}</button>
            </div>
          )}
          </div>
          <div className={ui.list}>
          {catalog.map((c) => (
            <button key={c.id} className={cx(ui.listItem, editing?.id === c.id && ui.listItemActive)} onClick={() => setEditing({ id: c.id, value: toInput(c) })}>
              <Dot color={c.color} />
              <div className={ui.grow}>
                <div className={ui.listTitle}>{c.name} <span className={cx(ui.muted, ui.mono, ui.small)}>{c.key}</span></div>
                <div className={cx(ui.muted, ui.small)}>{c.fields.length ? c.fields.map((f) => f.label).join(", ") : "tag (no fields)"}</div>
              </div>
              <span className={cx(ui.muted, ui.small)}>{c.usage ?? 0} use{c.usage === 1 ? "" : "s"}</span>
            </button>
          ))}
          </div>
        </div>
        {editing && (
          <div className={styles.panel}>
            <h3>{editing.id ? `Edit ${editing.value.name}` : "New component"}</h3>
            {editing.notes && <div className={ui.aiNote}><p>{editing.notes}</p></div>}
            <ComponentDefEditor value={editing.value} onChange={(value) => setEditing({ ...editing, value })} catalog={catalog} autoKey={!editing.id} />
            {editing.id && (
              <p className={cx(ui.muted, ui.small)}>Removing a field deletes its stored values. Changing a field's type clears its values.</p>
            )}
            <div className={ui.actions}>
              <button className={ui.primary} disabled={busy} onClick={save}>Save</button>
              <button onClick={() => setEditing(null)}>Cancel</button>
              <span className={ui.spacer} />
              {editing.id && <button className={ui.danger} disabled={busy} onClick={remove}>Delete</button>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
