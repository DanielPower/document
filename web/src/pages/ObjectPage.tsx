import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { DraftEditor } from "../components/DraftEditor";
import { useAppData } from "../data";
import type { DocumentSummary, Draft } from "../types";

const EMPTY: Draft = { title: "", documentDate: null, components: [], newComponents: [], newObjects: [] };

export function ObjectPage() {
  const { id } = useParams();
  const isNew = id === "new";
  const navigate = useNavigate();
  const { catalog, objects, refresh, toast } = useAppData();
  const [draft, setDraft] = useState<Draft | null>(isNew ? structuredClone(EMPTY) : null);
  const [original, setOriginal] = useState<Draft>(EMPTY);
  const [notes, setNotes] = useState("");
  const [docs, setDocs] = useState<DocumentSummary[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (isNew) { setDraft(structuredClone(EMPTY)); setNotes(""); setDocs([]); return; }
    api.getObject(id!).then((o) => { setDraft(structuredClone(o.current)); setOriginal(o.current); setNotes(o.notes); }).catch((e) => toast(e.message, "error"));
    api.searchDocuments({ ref: id, limit: 100 }).then((r) => setDocs(r.items)).catch(() => {});
  }, [id, isNew, toast]);

  if (!draft) return <div className="page muted">Loading…</div>;

  const save = async () => {
    setBusy(true);
    try {
      if (isNew) {
        const { id: newId } = await api.createObject(draft, notes);
        await refresh();
        navigate(`/objects/${newId}`, { replace: true });
      } else {
        await api.saveObject(id!, draft, notes);
        await refresh();
        const o = await api.getObject(id!);
        setDraft(structuredClone(o.current));
        setOriginal(o.current);
      }
      toast("Saved");
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page narrow">
      <p><Link to="/objects">← Objects</Link></p>
      <DraftEditor draft={draft} onChange={setDraft} catalog={catalog} objects={objects} selfId={isNew ? undefined : id} />
      <label>
        Notes
        <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>
      <div className="actions">
        <button className="primary" disabled={busy || !draft.title.trim()} onClick={save}>{isNew ? "Create" : "Save"}</button>
        {!isNew && <button disabled={busy} onClick={() => setDraft(structuredClone(original))}>Revert</button>}
        <span className="spacer" />
        {!isNew && (
          <button
            className="danger"
            disabled={busy}
            onClick={async () => {
              if (!confirm(`Delete this object? ${docs.length} document(s) link to it; those links will be cleared.`)) return;
              try { await api.deleteObject(id!); await refresh(); navigate("/objects"); } catch (e) { toast((e as Error).message, "error"); }
            }}
          >
            Delete
          </button>
        )}
      </div>
      {!isNew && (
        <>
          <h3>Linked documents ({docs.length})</h3>
          <div className="list">
            {docs.map((d) => (
              <Link key={d.id} to={`/documents/${d.id}`} className="list-item">
                <div className="title">{d.title}</div>
                <span className="muted small">{d.documentDate ?? ""}</span>
              </Link>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
