import { useRef, useState, type DragEvent } from "react";
import { NavLink, Route, Routes, useNavigate } from "react-router-dom";
import { api } from "./api";
import { AppDataProvider, useAppData } from "./data";
import { AskPage } from "./pages/Ask";
import { ComponentsPage } from "./pages/Components";
import { DocumentPage } from "./pages/DocumentPage";
import { DocumentsPage } from "./pages/Documents";
import { InboxPage } from "./pages/Inbox";
import { ObjectPage } from "./pages/ObjectPage";
import { ObjectsPage } from "./pages/Objects";

export function App() {
  return (
    <AppDataProvider>
      <Shell />
    </AppDataProvider>
  );
}

function Shell() {
  const { status, toast, refresh } = useAppData();
  const navigate = useNavigate();
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  const upload = async (files: File[]) => {
    if (!files.length) return;
    try {
      const { results } = await api.upload(files);
      const ok = results.filter((r) => r.id && !r.duplicate).length;
      const dupes = results.filter((r) => r.duplicate).length;
      for (const r of results.filter((r) => r.error)) toast(`${r.filename}: ${r.error}`, "error");
      if (ok) toast(`Uploaded ${ok} file${ok > 1 ? "s" : ""}; processing…`);
      if (dupes) toast(`${dupes} file${dupes > 1 ? "s were" : " was"} already in the archive.`);
      await refresh();
      if (ok) navigate("/");
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes("Files");
  const inbox = (status?.counts.inbox ?? 0);
  const processing = (status?.counts.queued ?? 0) + (status?.counts.ocr ?? 0) + (status?.counts.analyzing ?? 0);

  return (
    <div
      className="shell"
      onDragEnter={(e) => { if (hasFiles(e)) { dragDepth.current++; setDragging(true); } }}
      onDragLeave={() => { if (--dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false); } }}
      onDragOver={(e) => hasFiles(e) && e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        void upload([...e.dataTransfer.files]);
      }}
    >
      <header className="topbar">
        <span className="brand">Docket</span>
        <nav>
          <NavLink to="/" end>
            Inbox {inbox > 0 && <span className="count">{inbox}</span>}
            {processing > 0 && <span className="count processing" title="Processing">{processing}…</span>}
          </NavLink>
          <NavLink to="/documents">Documents</NavLink>
          {status?.ai && <NavLink to="/ask">Ask</NavLink>}
          <NavLink to="/objects">Objects</NavLink>
          <NavLink to="/components">Components</NavLink>
        </nav>
        <span className="spacer" />
        {status && !status.ai && <span className="muted small" title="Set ANTHROPIC_API_KEY to enable">AI off</span>}
        <button className="primary" onClick={() => fileInput.current?.click()}>Upload</button>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          accept=".pdf,.png,.jpg,.jpeg,.tif,.tiff,.gif,.txt,.md"
          onChange={(e) => { void upload([...(e.target.files ?? [])]); e.target.value = ""; }}
        />
      </header>
      <main>
        <Routes>
          <Route path="/" element={<InboxPage />} />
          <Route path="/inbox/:id" element={<InboxPage />} />
          <Route path="/documents" element={<DocumentsPage />} />
          <Route path="/documents/:id" element={<DocumentPage />} />
          <Route path="/ask" element={<AskPage />} />
          <Route path="/objects" element={<ObjectsPage />} />
          <Route path="/objects/:id" element={<ObjectPage />} />
          <Route path="/components" element={<ComponentsPage />} />
        </Routes>
      </main>
      {dragging && <div className="drop-overlay">Drop files to add them to the inbox</div>}
    </div>
  );
}
