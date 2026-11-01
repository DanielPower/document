/** A few line icons for the navigation, drawn on a 20×20 grid with the current text color. */
const PATHS: Record<string, string> = {
  inbox: "M3 11.5 5.2 4.6A1.5 1.5 0 0 1 6.6 3.5h6.8a1.5 1.5 0 0 1 1.4 1.1L17 11.5M3 11.5V15a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 17 15v-3.5M3 11.5h4l1 2h4l1-2h4",
  documents: "M5.5 2.5h6l3.5 3.5v10a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 4 16V4a1.5 1.5 0 0 1 1.5-1.5ZM11.5 2.5V6H15M7 10h6M7 13h6",
  objects: "M10 2.5 16.5 6v8L10 17.5 3.5 14V6L10 2.5ZM3.5 6 10 9.5 16.5 6M10 9.5v8",
  ask: "M4 4.5h12a1 1 0 0 1 1 1v7.5a1 1 0 0 1-1 1H9l-4 3v-3H4a1 1 0 0 1-1-1V5.5a1 1 0 0 1 1-1ZM7 8.5h6M7 11h4",
  search: "M8.5 14a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11ZM12.5 12.5l4.5 4.5",
  settings: "M10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4",
  plus: "M10 4v12M4 10h12",
  camera: "M3 6.5h3l1.5-2h5L14 6.5h3v9.5H3V6.5ZM10 13.5a2.8 2.8 0 1 0 0-5.6 2.8 2.8 0 0 0 0 5.6Z",
  upload: "M10 13V3.5M6 7.5l4-4 4 4M3.5 13.5V16h13v-2.5",
  up: "M5 12.5 10 7.5l5 5",
  down: "M5 7.5l5 5 5-5",
  expand: "M12 3.5h4.5V8M8 16.5H3.5V12M16.5 3.5 11.5 8.5M3.5 16.5l5-5",
  close: "M5 5l10 10M15 5 5 15",
};

export function Icon({ name, size = 18 }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name] ?? ""} />
    </svg>
  );
}
