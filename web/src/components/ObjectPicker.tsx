import { useId, useMemo, useRef, useState } from "react";
import { cx } from "../cx";
import ui from "../ui.module.css";
import styles from "./ObjectPicker.module.css";

export interface PickerOption {
  /** An object id, or "new:<tempId>" for an object the draft will create. */
  value: string;
  title: string;
  detail?: string;
  /** Shown as a small label, e.g. "new". */
  tag?: string;
}

type Row = { kind: "option"; option: PickerOption } | { kind: "create"; title: string };

/** Lowercase words of a string, for matching in any order. */
const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/**
 * A type-to-search picker for linking to an object. Every word typed must
 * appear in the object's title or details. When nothing matches exactly, the
 * last row creates a new object with the typed name.
 */
export function ObjectPicker(props: {
  value: string | null;
  options: PickerOption[];
  onChange: (value: string | null) => void;
  /** Offered as the last row; called with the typed name. */
  onCreate?: (title: string) => void;
  placeholder?: string;
}) {
  const { value, options, onChange, onCreate } = props;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const current = options.find((o) => o.value === value);

  const rows = useMemo<Row[]>(() => {
    const q = words(query);
    const hits = options.filter((o) => {
      const hay = words(`${o.title} ${o.detail ?? ""}`);
      return q.every((w) => hay.some((h) => h.startsWith(w)));
    });
    const out: Row[] = hits.map((option) => ({ kind: "option", option }));
    const typed = query.trim();
    if (onCreate && typed && !options.some((o) => o.title.toLowerCase() === typed.toLowerCase())) out.push({ kind: "create", title: typed });
    return out;
  }, [options, query, onCreate]);

  const close = () => { setOpen(false); setQuery(""); setActive(0); };

  const choose = (r: Row | undefined) => {
    if (!r) return;
    if (r.kind === "create") onCreate?.(r.title);
    else onChange(r.option.value);
    close();
    input.current?.blur();
  };

  return (
    <div className={styles.picker}>
      <div className={styles.control}>
        <input
          ref={input}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          value={open ? query : current?.title ?? ""}
          placeholder={open && current ? current.title : props.placeholder ?? "Search objects…"}
          onFocus={() => setOpen(true)}
          onBlur={close}
          onChange={(e) => { setQuery(e.target.value); setActive(0); setOpen(true); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, rows.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
            else if (e.key === "Enter" && open) { e.preventDefault(); choose(rows[active]); }
            else if (e.key === "Escape") { close(); input.current?.blur(); }
          }}
        />
        {value && !open && (
          <button type="button" className={cx(ui.icon, styles.clear)} title="Clear" onClick={() => onChange(null)}>✕</button>
        )}
      </div>
      {open && (
        <ul className={styles.list} id={listId} role="listbox">
          {rows.length === 0 && <li className={cx(styles.empty, ui.muted, ui.small)}>No matching objects</li>}
          {rows.map((r, i) => (
            <li
              key={r.kind === "create" ? "__create" : r.option.value}
              role="option"
              aria-selected={i === active}
              className={cx(styles.row, i === active && styles.rowActive)}
              // mousedown, not click: the input's blur would close the list first.
              onMouseDown={(e) => { e.preventDefault(); choose(r); }}
              onMouseEnter={() => setActive(i)}
            >
              {r.kind === "create" ? (
                <span className={styles.create}>+ Create “{r.title}”</span>
              ) : (
                <>
                  <span className={styles.rowTitle}>
                    {r.option.title}
                    {r.option.tag && <span className={cx(ui.badge, ui.badgeNew, styles.tag)}>{r.option.tag}</span>}
                    {r.option.value === value && <span className={cx(ui.muted, ui.small)}> · selected</span>}
                  </span>
                  {r.option.detail && <span className={cx(ui.muted, ui.small, styles.detail)}>{r.option.detail}</span>}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
