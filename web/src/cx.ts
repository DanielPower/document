/** Joins class names, skipping falsy values: cx(ui.button, active && styles.active). */
export function cx(...names: Array<string | false | null | undefined>): string {
  return names.filter(Boolean).join(" ");
}
