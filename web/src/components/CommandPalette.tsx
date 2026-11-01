import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { cx } from "../cx";
import { useAppData } from "../data";
import ui from "../ui.module.css";
import type { DocumentSummary } from "../types";
import { ComponentDots } from "./Chip";
import { Icon } from "./Icon";
import styles from "./CommandPalette.module.css";

type Row =
  | { kind: "ask"; text: string }
  | { kind: "search"; text: string }
  | { kind: "doc"; doc: DocumentSummary }
  | { kind: "object"; id: string; title: string; summary: string };

/** Questions go to Ask; everything else to a document search. */
const looksLikeQuestion = (s: string) => /\?\s*$/.test(s) || /^(how|what|when|where|which|who|why|is|are|do|did|does|show|list|find)\b/i.test(s.trim());

/**
 * One box for finding anything: documents and objects as you type, a full
 * document search, or a question for Ask. Opens with ⌘K, Ctrl+K or "/".
 */
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const { objects, catalog, status } = useAppData();
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const [docs, setDocs] = useState<DocumentSummary[]>([]);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { input.current?.focus(); }, []);

  useEffect(() => {
    const q = text.trim();
    if (q.length < 2) { setDocs([]); return; }
    let live = true;
    const t = setTimeout(() => {
      api.searchDocuments({ q, limit: 6, semantic: false }).then((r) => live && setDocs(r.items)).catch(() => {});
    }, 180);
    return () => { live = false; clearTimeout(t); };
  }, [text]);

  const rows = useMemo<Row[]>(() => {
    const q = text.trim();
    if (!q) return [];
    const words = q.toLowerCase().split(/\s+/);
    const objs = objects
      .filter((o) => words.every((w) => `${o.title} ${o.summary}`.toLowerCase().includes(w)))
      .slice(0, 4)
      .map((o): Row => ({ kind: "object", id: o.id, title: o.title, summary: o.summary }));
    const ask: Row[] = status?.ai ? [{ kind: "ask", text: q }] : [];
    const search: Row = { kind: "search", text: q };
    const head = status?.ai && looksLikeQuestion(q) ? [...ask, search] : [search, ...ask];
    return [...head, ...docs.map((doc): Row => ({ kind: "doc", doc })), ...objs];
  }, [text, docs, objects, status]);

  useEffect(() => setActive(0), [text]);

  const go = (r: Row | undefined) => {
    if (!r) return;
    if (r.kind === "ask") navigate(`/ask?q=${encodeURIComponent(r.text)}`);
    else if (r.kind === "search") navigate(`/documents?q=${encodeURIComponent(r.text)}&status=all`);
    else if (r.kind === "doc") navigate(r.doc.status === "filed" ? `/documents/${r.doc.id}` : `/inbox/${r.doc.id}`);
    else navigate(`/objects/${r.id}`);
    onClose();
  };

  return (
    <div className={styles.backdrop} onMouseDown={onClose}>
      <div className={styles.palette} role="dialog" aria-label="Search" onMouseDown={(e) => e.stopPropagation()}>
        <div className={styles.inputRow}>
          <Icon name="search" size={16} />
          <input
            ref={input}
            value={text}
            placeholder={status?.ai ? "Search documents and objects, or ask a question" : "Search documents and objects"}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, rows.length - 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
              else if (e.key === "Enter") { e.preventDefault(); go(rows[active]); }
              else if (e.key === "Escape") onClose();
            }}
            aria-controls="palette-list"
          />
          <kbd>Esc</kbd>
        </div>
        {rows.length > 0 && (
          <ul className={styles.list} id="palette-list" role="listbox">
            {rows.map((r, i) => (
              <li
                key={r.kind === "doc" ? r.doc.id : r.kind === "object" ? r.id : r.kind}
                role="option"
                aria-selected={i === active}
                className={cx(styles.row, i === active && styles.rowActive)}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => { e.preventDefault(); go(r); }}
              >
                {r.kind === "ask" && <><span className={ui.aiMark}>ASK</span><span className={styles.main}>{r.text}</span><span className={cx(ui.muted, ui.small)}>answer with citations</span></>}
                {r.kind === "search" && <><span className={styles.kind}>Search</span><span className={styles.main}>Documents matching “{r.text}”</span></>}
                {r.kind === "doc" && (
                  <>
                    <span className={styles.kind}>{r.doc.status === "filed" ? "Document" : "Inbox"}</span>
                    <span className={styles.main}>{r.doc.title}</span>
                    <ComponentDots keys={r.doc.components} catalog={catalog} />
                    <span className={cx(ui.muted, ui.small)}>{r.doc.documentDate ?? ""}</span>
                  </>
                )}
                {r.kind === "object" && <><span className={styles.kind}>Object</span><span className={styles.main}>{r.title}</span><span className={cx(ui.muted, ui.small, styles.detail)}>{r.summary}</span></>}
              </li>
            ))}
          </ul>
        )}
        {!text && <p className={cx(ui.muted, ui.small, styles.hint)}>Type to find documents and objects. ↑↓ to move, Enter to open.</p>}
      </div>
    </div>
  );
}
