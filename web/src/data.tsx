import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, type Status } from "./api";
import { cx } from "./cx";
import styles from "./data.module.css";
import type { ComponentDef, ObjectSummary } from "./types";

interface AppData {
  catalog: ComponentDef[];
  objects: ObjectSummary[];
  status: Status | null;
  refresh: () => Promise<void>;
  toast: (msg: string, kind?: "info" | "error", action?: ToastAction) => void;
}

/** A button on a toast, e.g. Undo. */
export interface ToastAction {
  label: string;
  run: () => void | Promise<void>;
}

const Ctx = createContext<AppData | null>(null);

export function AppDataProvider({ children }: { children: ReactNode }) {
  const [catalog, setCatalog] = useState<ComponentDef[]>([]);
  const [objects, setObjects] = useState<ObjectSummary[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [toasts, setToasts] = useState<Array<{ id: number; msg: string; kind: string; action?: ToastAction }>>([]);

  const refresh = useCallback(async () => {
    const [c, o, s] = await Promise.all([api.components(), api.objects(), api.status()]);
    setCatalog(c);
    setObjects(o);
    setStatus(s);
  }, []);

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const toast = useCallback((msg: string, kind: "info" | "error" = "info", action?: ToastAction) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, msg, kind, action }]);
    // Toasts with an action stay long enough to use it.
    setTimeout(() => dismiss(id), kind === "error" ? 9000 : action ? 10000 : 4000);
  }, [dismiss]);

  useEffect(() => {
    refresh().catch((e) => toast(e.message, "error"));
    // Keep the inbox badge fresh.
    const t = setInterval(() => api.status().then(setStatus).catch(() => {}), 10_000);
    return () => clearInterval(t);
  }, [refresh, toast]);

  return (
    <Ctx.Provider value={{ catalog, objects, status, refresh, toast }}>
      {children}
      <div className={styles.toasts}>
        {toasts.map((t) => (
          <div key={t.id} className={cx(styles.toast, t.kind === "error" && styles.toastError)}>
            {t.msg}
            {t.action && (
              <button
                className={styles.toastAction}
                onClick={async () => {
                  dismiss(t.id);
                  try { await t.action!.run(); } catch (e) { toast((e as Error).message, "error"); }
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
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
