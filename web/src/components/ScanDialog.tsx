import { useEffect, useRef, useState } from "react";
import { cx } from "../cx";
import { jpegsToPdf, type JpegPage } from "../scanPdf";
import ui from "../ui.module.css";
import styles from "./ScanDialog.module.css";

/** Longest side of a scanned page, in pixels: about 220 DPI on Letter, plenty for OCR. */
const MAX_SIDE = 2400;

type ScanPage = JpegPage & { id: number; url: string };

let nextId = 1;

/** Downscales a camera photo, applies its EXIF rotation, and re-encodes it as JPEG. */
async function toPage(file: File): Promise<ScanPage> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const k = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * k);
  const height = Math.round(bitmap.height * k);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "white"; // transparent PNGs would otherwise turn black in JPEG
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't encode the photo"))), "image/jpeg", 0.85),
  );
  return { id: nextId++, data: new Uint8Array(await blob.arrayBuffer()), width, height, url: URL.createObjectURL(blob) };
}

function scanName() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `Scan ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}.pdf`;
}

/**
 * Takes photos with the rear camera, one per page, and uploads them as one PDF.
 * Opens the camera straight away; the page list appears after the first photo.
 */
export function ScanDialog({ onClose, onUpload }: { onClose: () => void; onUpload: (files: File[]) => Promise<void> }) {
  const camera = useRef<HTMLInputElement>(null);
  const [pages, setPages] = useState<ScanPage[]>([]);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const opened = useRef(false);

  // Open the camera on mount. The click that opened the dialog still counts as the user's gesture.
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    camera.current?.click();
  }, []);

  // Free the thumbnails' object URLs when the dialog closes.
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  useEffect(() => () => pagesRef.current.forEach((p) => URL.revokeObjectURL(p.url)), []);

  const add = async (files: File[]) => {
    if (!files.length) {
      if (!pages.length) onClose(); // cancelled the camera before taking anything
      return;
    }
    setWorking("Processing photo…");
    setError(null);
    try {
      const added = await Promise.all(files.map(toPage));
      setPages((ps) => [...ps, ...added]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWorking(null);
    }
  };

  const remove = (id: number) =>
    setPages((ps) => {
      const p = ps.find((x) => x.id === id);
      if (p) URL.revokeObjectURL(p.url);
      return ps.filter((x) => x.id !== id);
    });

  const move = (i: number, dir: -1 | 1) =>
    setPages((ps) => {
      const next = [...ps];
      [next[i], next[i + dir]] = [next[i + dir], next[i]];
      return next;
    });

  const upload = async () => {
    setWorking("Uploading…");
    try {
      const pdf = jpegsToPdf(pages);
      await onUpload([new File([pdf as BlobPart], scanName(), { type: "application/pdf" })]);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setWorking(null);
    }
  };

  return (
    <div className={styles.backdrop} role="dialog" aria-modal="true" aria-label="Scan a document">
      <div className={styles.dialog}>
        <div className={styles.head}>
          <strong>Scan</strong>
          <span className={cx(ui.muted, ui.small)}>{pages.length} page{pages.length === 1 ? "" : "s"}</span>
          <span className={ui.spacer} />
          <button className={ui.icon} onClick={onClose} aria-label="Cancel">✕</button>
        </div>
        {error && <div className={cx(ui.alert, ui.error)}>{error}</div>}
        <div className={styles.pages}>
          {pages.map((p, i) => (
            <figure key={p.id} className={styles.page}>
              <img src={p.url} alt={`Page ${i + 1}`} />
              <figcaption className={styles.pageBar}>
                <button className={ui.icon} disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move earlier">‹</button>
                <span className={ui.small}>{i + 1}</span>
                <button className={ui.icon} disabled={i === pages.length - 1} onClick={() => move(i, 1)} aria-label="Move later">›</button>
                <button className={cx(ui.icon, ui.danger)} onClick={() => remove(p.id)} aria-label="Remove page">✕</button>
              </figcaption>
            </figure>
          ))}
          <button className={styles.addPage} disabled={!!working} onClick={() => camera.current?.click()}>
            {working === "Processing photo…" ? working : pages.length ? "+ Add page" : "+ Take photo"}
          </button>
        </div>
        <div className={styles.foot}>
          <button onClick={onClose}>Cancel</button>
          <span className={ui.spacer} />
          <button className={ui.primary} disabled={!pages.length || !!working} onClick={upload}>
            {working === "Uploading…" ? working : `Upload${pages.length > 1 ? ` ${pages.length} pages` : ""} as one document`}
          </button>
        </div>
      </div>
      <input
        ref={camera}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(e) => { void add([...(e.target.files ?? [])]); e.target.value = ""; }}
      />
    </div>
  );
}
