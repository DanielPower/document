import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, type Status } from "./api";
import type { ComponentDef, ObjectSummary } from "./types";

interface AppData {
  catalog: ComponentDef[];
  objects: ObjectSummary[];
  status: Status | null;
  refresh: () => Promise<void>;
  toast: (msg: string, kind?: "info" | "error") => void;
}

const Ctx = createContext<AppData | null>(null);

export function AppDataProvider({ children }: { children: ReactNode }) {
  const [catalog, setCatalog] = useState<ComponentDef[]>([]);
  const [objects, setObjects] = useState<ObjectSummary[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [toasts, setToasts] = useState<Array<{ id: number; msg: string; kind: string }>>([]);

  const refresh = useCallback(async () => {
    const [c, o, s] = await Promise.all([api.components(), api.objects(), api.status()]);
    setCatalog(c);
    setObjects(o);
    setStatus(s);
  }, []);

  const toast = useCallback((msg: string, kind: "info" | "error" = "info") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 9000 : 4000);
  }, []);

  useEffect(() => {
    refresh().catch((e) => toast(e.message, "error"));
    // Keep the inbox badge fresh.
    const t = setInterval(() => api.status().then(setStatus).catch(() => {}), 10_000);
    return () => clearInterval(t);
  }, [refresh, toast]);

  return (
    <Ctx.Provider value={{ catalog, objects, status, refresh, toast }}>
      {children}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>{t.msg}</div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useAppData(): AppData {
  const v = useContext(Ctx);
  if (!v) throw new Error("AppDataProvider missing");
  return v;
}
