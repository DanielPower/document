import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, thumbUrl } from "../api";
import { cx } from "../cx";
import { useAppData } from "../data";
import ui from "../ui.module.css";
import styles from "./Trash.module.css";
import type { DocumentSummary } from "../types";

/** Documents moved to the trash. They're deleted for good after 30 days. */
export function TrashPage() {
  const { refresh, toast } = useAppData();
  const [items, setItems] = useState<DocumentSummary[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api.searchDocuments({ status: ["trashed"], sort: "added", limit: 200 }).then((r) => setItems(r.items)), []);
  useEffect(() => { load().catch((e) => toast(e.message, "error")); }, [load, toast]);

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await fn();
      toast(done);
      await Promise.all([load(), refresh()]);
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={cx(ui.page, ui.narrow)}>
      <p><Link to="/documents">← Documents</Link></p>
      <div className={ui.pageHead}>
        <h2>Trash</h2>
        <p className={ui.muted}>Documents here are deleted for good, with their files, 30 days after they were moved here.</p>
        {!!items?.length && (
          <button
            className={ui.danger}
            disabled={busy}
            onClick={() => confirm(`Delete ${items.length} document(s) and their files for good? This can't be undone.`) && run(() => api.emptyTrash(), "Trash emptied")}
          >
            Empty trash
          </button>
        )}
      </div>
      {items && !items.length && <p className={ui.muted}>The trash is empty.</p>}
      <div className={ui.list}>
        {items?.map((d) => (
          <div key={d.id} className={ui.listItem}>
            {d.hasThumb ? <img className={styles.thumb} src={thumbUrl(d.id)} alt="" /> : <div className={cx(ui.thumbPlaceholder, styles.fixed)}>{d.mimeType.split("/")[1]}</div>}
            <div>
              <div className={ui.listTitle}>{d.title}</div>
              <div className={cx(ui.muted, ui.small)}>{d.documentDate ?? "no date"} · {d.originalFilename}</div>
            </div>
            <button disabled={busy} onClick={() => run(() => api.restoreDocument(d.id), `Restored “${d.title}”`)}>Restore</button>
            <button
              className={ui.danger}
              disabled={busy}
              onClick={() => confirm(`Delete “${d.title}” and its files for good?`) && run(() => api.deleteDocument(d.id, true), "Deleted")}
            >
              Delete forever
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
