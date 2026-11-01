import type { CSSProperties } from "react";
import { cx } from "../cx";
import ui from "../ui.module.css";
import type { ComponentDef } from "../types";

/** "insurance_policy" -> "Insurance policy", for components proposed but not created yet. */
export const humanizeKey = (key: string) => key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, " ");

/** A small colored square: how a component's color is shown (never behind text). */
export function Dot({ color, title }: { color?: string; title?: string }) {
  return <i className={ui.dot} style={{ "--c": color } as CSSProperties} title={title} />;
}

/** A component as a chip: its color as a dot, then its name. */
export function ComponentChip({ componentKey, catalog, name, color, className }: {
  componentKey: string;
  catalog: ComponentDef[];
  /** For proposed components that aren't in the catalog yet. */
  name?: string;
  color?: string;
  className?: string;
}) {
  const def = catalog.find((c) => c.key === componentKey);
  return (
    <span className={cx(ui.chip, className)}>
      <Dot color={def?.color ?? color} />
      {def?.name ?? name ?? humanizeKey(componentKey)}
    </span>
  );
}

/** Components as a row of dots, with names on hover. */
export function ComponentDots({ keys, catalog }: { keys: string[]; catalog: ComponentDef[] }) {
  return (
    <span className={ui.dots}>
      {keys.map((k, i) => {
        const def = catalog.find((c) => c.key === k);
        return <Dot key={i} color={def?.color} title={def?.name ?? humanizeKey(k)} />;
      })}
    </span>
  );
}
