import { useEffect, useRef, useState, type DragEvent } from "react";
import { NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import styles from "./App.module.css";
import { api } from "./api";
import { cx } from "./cx";
import ui from "./ui.module.css";
import { AppDataProvider, useAppData } from "./data";
import { ScanDialog } from "./components/ScanDialog";
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

/** NavLink passes isActive; replaces its default global "active" class. */
const navClass = ({ isActive }: { isActive: boolean }) => cx(styles.navLink, isActive && styles.navLinkActive);

function Shell() {
  const { status, toast, refresh } = useAppData();
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const [dragging, setDragging] = useState(false);
  const [scanning, setScanning] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  // Files shared to Docket from another app land on /share, which redirects here with ?notice=…&error=….
  useEffect(() => {
    const params = new URLSearchParams(search);
    const notice = params.get("notice");
    const error = params.get("error");
    if (notice === null && error === null) return;
    if (notice) toast(notice);
    if (error) toast(error, "error");
    params.delete("notice");
    params.delete("error");
    navigate({ pathname, search: params.size ? `?${params}` : "" }, { replace: true });
  }, [search, pathname, navigate, toast]);

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
      className={styles.shell}
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
      <header className={styles.topbar}>
        <span className={styles.brand}>Docket</span>
        <nav className={styles.nav}>
          <NavLink to="/" className={() => navClass({ isActive: pathname === "/" || pathname.startsWith("/inbox/") })}>
            Inbox
            <span className={styles.navCounts}>
              {inbox > 0 && <span className={styles.count}>{inbox}</span>}
              {processing > 0 && <span className={cx(styles.count, styles.countProcessing)} title="Processing">{processing}…</span>}
            </span>
          </NavLink>
          <NavLink to="/documents" className={navClass}>Documents</NavLink>
          {status?.ai && <NavLink to="/ask" className={navClass}>Ask</NavLink>}
          <NavLink to="/objects" className={navClass}>Objects</NavLink>
          <NavLink to="/components" className={navClass}>Components</NavLink>
        </nav>
        <span className={ui.spacer} />
        {status && !status.ai && <span className={cx(ui.muted, ui.small)} title="Set ANTHROPIC_API_KEY to enable">AI off</span>}
        <div className={styles.actions}>
          <button onClick={() => setScanning(true)} title="Take photos of a document, one per page">Scan</button>
          <button className={ui.primary} onClick={() => fileInput.current?.click()}>Upload</button>
        </div>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          accept=".pdf,.png,.jpg,.jpeg,.tif,.tiff,.gif,.txt,.md"
          onChange={(e) => { void upload([...(e.target.files ?? [])]); e.target.value = ""; }}
        />
      </header>
      <main className={styles.main}>
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
      {scanning && <ScanDialog onClose={() => setScanning(false)} onUpload={upload} />}
      {dragging && <div className={styles.dropOverlay}>Drop files to add them to the inbox</div>}
    </div>
  );
}
