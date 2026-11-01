import { useEffect, useRef, useState, type DragEvent } from "react";
import { NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import styles from "./App.module.css";
import { api } from "./api";
import { cx } from "./cx";
import ui from "./ui.module.css";
import { AppDataProvider, useAppData } from "./data";
import { CommandPalette } from "./components/CommandPalette";
import { Icon } from "./components/Icon";
import { ScanDialog } from "./components/ScanDialog";
import { AskPage } from "./pages/Ask";
import { ComponentsPage } from "./pages/Components";
import { DocumentPage } from "./pages/DocumentPage";
import { DocumentsPage } from "./pages/Documents";
import { InboxPage } from "./pages/Inbox";
import { ObjectPage } from "./pages/ObjectPage";
import { ObjectsPage } from "./pages/Objects";
import { TrashPage } from "./pages/Trash";

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
  const settingsMenu = useRef<HTMLDetailsElement>(null);

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
      const ok = results.filter((r) => r.id && !r.duplicate && !r.restored).length;
      const restored = results.filter((r) => r.restored).length;
      const dupes = results.filter((r) => r.duplicate).length;
      for (const r of results.filter((r) => r.error)) toast(`${r.filename}: ${r.error}`, "error");
      if (ok) toast(`Uploaded ${ok} file${ok > 1 ? "s" : ""}; processing…`);
      if (restored) toast(`${restored} file${restored > 1 ? "s were" : " was"} in the trash and ${restored > 1 ? "have" : "has"} been restored.`);
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

  // ⌘K / Ctrl+K anywhere, or "/" when not typing, opens search.
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setSearching(true); }
      else if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); setSearching(true); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);
  const [adding, setAdding] = useState(false);
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

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
            <span className={styles.navIcon}><Icon name="inbox" /></span>
            <span className={styles.navLabel}>Inbox</span>
            <span className={styles.navCounts}>
              {inbox > 0 && <span className={styles.count}>{inbox}</span>}
              {processing > 0 && <span className={cx(styles.count, styles.countProcessing)} title="Processing">{processing}…</span>}
            </span>
          </NavLink>
          <NavLink to="/documents" className={navClass}><span className={styles.navIcon}><Icon name="documents" /></span><span className={styles.navLabel}>Documents</span></NavLink>
          <button className={styles.addTab} onClick={() => setAdding(true)} aria-label="Add documents"><Icon name="plus" size={22} /></button>
          <NavLink to="/objects" className={navClass}><span className={styles.navIcon}><Icon name="objects" /></span><span className={styles.navLabel}>Objects</span></NavLink>
          {status?.ai && <NavLink to="/ask" className={navClass}><span className={styles.navIcon}><Icon name="ask" /></span><span className={styles.navLabel}>Ask</span></NavLink>}
        </nav>
        <button className={styles.searchBox} onClick={() => setSearching(true)} aria-label="Search">
          <Icon name="search" size={15} />
          <span className={styles.searchText}>{status?.ai ? "Search documents, objects, or ask a question" : "Search documents and objects"}</span>
          <kbd className={styles.searchKey}>{isMac ? "⌘K" : "Ctrl K"}</kbd>
        </button>
        <span className={ui.spacer} />
        {status && !status.ai && <span className={cx(ui.muted, ui.small, styles.aiOff)} title="Set ANTHROPIC_API_KEY to enable">AI off</span>}
        <div className={styles.actions}>
          <button onClick={() => setScanning(true)} title="Take photos of a document, one per page">Scan</button>
          <button className={ui.primary} onClick={() => fileInput.current?.click()}>Upload</button>
        </div>
        <details className={ui.menuWrap} ref={settingsMenu}>
          <summary className={cx(ui.button, ui.ghost, styles.settings)} aria-label="Settings and more" title="Components, trash"><Icon name="settings" /></summary>
          <div className={ui.menu} onClick={() => settingsMenu.current?.removeAttribute("open")}>
            <NavLink to="/components">Components</NavLink>
            <NavLink to="/trash">Trash</NavLink>
          </div>
        </details>
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
          <Route path="/inbox" element={<InboxPage />} />
          <Route path="/inbox/:id" element={<InboxPage />} />
          <Route path="/documents" element={<DocumentsPage />} />
          <Route path="/documents/:id" element={<DocumentPage />} />
          <Route path="/ask" element={<AskPage />} />
          <Route path="/objects" element={<ObjectsPage />} />
          <Route path="/objects/:id" element={<ObjectPage />} />
          <Route path="/components" element={<ComponentsPage />} />
          <Route path="/trash" element={<TrashPage />} />
        </Routes>
      </main>
      {scanning && <ScanDialog onClose={() => setScanning(false)} onUpload={upload} />}
      {searching && <CommandPalette onClose={() => setSearching(false)} />}
      {adding && (
        <div className={styles.sheetBackdrop} onClick={() => setAdding(false)}>
          <div className={styles.sheet} role="dialog" aria-label="Add documents" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => { setAdding(false); setScanning(true); }}><Icon name="camera" /> Scan with the camera</button>
            <button onClick={() => { setAdding(false); fileInput.current?.click(); }}><Icon name="upload" /> Upload files</button>
            <button className={ui.ghost} onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </div>
      )}
      {dragging && <div className={styles.dropOverlay}>Drop files to add them to the inbox</div>}
    </div>
  );
}
