/* Reading dates and amounts the way people type them. */

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const pad = (n: number) => String(n).padStart(2, "0");
const valid = (y: number, m: number, d: number) => {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};

/**
 * Reads a typed date: 2026-10-28, 2026/10/28, Oct 28 2026, 28 October 2026.
 * Day/month orders like 10/11/2026 are ambiguous and not accepted. Returns
 * "YYYY-MM-DD", null for an empty string, or undefined when it can't be read.
 */
export function parseDate(s: string): string | null | undefined {
  const t = s.trim().toLowerCase().replace(/,/g, " ").replace(/\s+/g, " ");
  if (!t) return null;
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(t);
  if (m) return valid(+m[1], +m[2], +m[3]) ? `${m[1]}-${pad(+m[2])}-${pad(+m[3])}` : undefined;
  m = /^([a-z]+)\.? (\d{1,2}) (\d{4})$/.exec(t);
  if (m) {
    const mo = MONTHS.indexOf(m[1].slice(0, 3)) + 1;
    return mo && valid(+m[3], mo, +m[2]) ? `${m[3]}-${pad(mo)}-${pad(+m[2])}` : undefined;
  }
  m = /^(\d{1,2}) ([a-z]+)\.? (\d{4})$/.exec(t);
  if (m) {
    const mo = MONTHS.indexOf(m[2].slice(0, 3)) + 1;
    return mo && valid(+m[3], mo, +m[1]) ? `${m[3]}-${pad(mo)}-${pad(+m[1])}` : undefined;
  }
  m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(t);
  if (m && (+m[1] > 12) !== (+m[2] > 12)) {
    const [d, mo] = +m[1] > 12 ? [+m[1], +m[2]] : [+m[2], +m[1]];
    return valid(+m[3], mo, d) ? `${m[3]}-${pad(mo)}-${pad(d)}` : undefined;
  }
  return undefined;
}

/** Reads a typed amount: "1,284.00", "96.05", "1 284,50". */
export function parseNumber(s: string): number | null | undefined {
  let t = s.trim().replace(/[\s$€£]/g, "");
  if (!t) return null;
  // "1.284,50" or "1284,50": a comma followed by two digits at the end is the decimal mark.
  if (/,\d{1,2}$/.test(t) && !/\.\d{1,2}$/.test(t)) t = t.replace(/\./g, "").replace(",", ".");
  else t = t.replace(/,/g, "");
  const n = Number(t);
  return t !== "" && Number.isFinite(n) ? n : undefined;
}

