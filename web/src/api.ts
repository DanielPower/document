import type {
  ComponentDef,
  ComponentInput,
  DocumentDetail,
  DocumentSummary,
  Draft,
  ObjectDetail,
  ObjectSummary,
} from "./types";

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined && !(body instanceof FormData) ? { "content-type": "application/json" } : undefined,
    body: body instanceof FormData ? body : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error ?? `${res.status} ${res.statusText}`);
  return data as T;
}

export interface Status {
  ai: boolean;
  model: string;
  counts: Record<string, number>;
}

export interface SearchQuery {
  q?: string;
  status?: string[];
  component?: string[];
  ref?: string;
  where?: string[];
  from?: string;
  to?: string;
  sort?: string;
  limit?: number;
  offset?: number;
}

function qs(params: SearchQuery): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === "" || (Array.isArray(v) && !v.length)) continue;
    if (Array.isArray(v)) {
      if (k === "where") v.forEach((x) => u.append(k, x));
      else u.set(k, v.join(","));
    } else u.set(k, String(v));
  }
  return u.toString();
}

export const api = {
  status: () => request<Status>("GET", "/api/status"),

  searchDocuments: (p: SearchQuery) => request<{ total: number; items: DocumentSummary[] }>("GET", `/api/documents?${qs(p)}`),
  getDocument: (id: string) => request<DocumentDetail>("GET", `/api/documents/${id}`),
  saveDocument: (id: string, draft: Draft, file: boolean) => request<{ ok: true }>("PUT", `/api/documents/${id}/draft`, { draft, file }),
  reanalyze: (id: string, ocr = false) => request<{ ok: true }>("POST", `/api/documents/${id}/reanalyze`, { ocr }),
  deleteDocument: (id: string) => request<{ ok: true }>("DELETE", `/api/documents/${id}`),
  upload: (files: File[]) => {
    const form = new FormData();
    files.forEach((f) => form.append("file", f, f.name));
    return request<{ results: Array<{ filename: string; id?: string; duplicate?: boolean; error?: string }> }>("POST", "/api/documents", form);
  },

  components: () => request<ComponentDef[]>("GET", "/api/components"),
  createComponent: (c: ComponentInput) => request<{ id: string }>("POST", "/api/components", c),
  updateComponent: (id: string, c: ComponentInput) => request<{ ok: true }>("PUT", `/api/components/${id}`, c),
  deleteComponent: (id: string, force = false) => request<{ ok: true }>("DELETE", `/api/components/${id}${force ? "?force=1" : ""}`),
  generateComponent: (description: string) =>
    request<{ component: ComponentInput; notes: string }>("POST", "/api/ai/generate-component", { description }),

  objects: (q?: string) => request<ObjectSummary[]>("GET", `/api/objects${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  getObject: (id: string) => request<ObjectDetail>("GET", `/api/objects/${id}`),
  createObject: (draft: Draft, notes: string) => request<{ id: string }>("POST", "/api/objects", { draft, notes }),
  saveObject: (id: string, draft: Draft, notes: string) => request<{ ok: true }>("PUT", `/api/objects/${id}`, { draft, notes }),
  deleteObject: (id: string) => request<{ ok: true }>("DELETE", `/api/objects/${id}`),
};

export const fileUrl = (id: string, kind: "archive" | "original" = "archive", download = false) =>
  `/api/documents/${id}/file?kind=${kind}${download ? "&download=1" : ""}`;
export const thumbUrl = (id: string) => `/api/documents/${id}/thumb`;
