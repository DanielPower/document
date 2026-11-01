import { useEffect, useState, type InputHTMLAttributes } from "react";
import { cx } from "../cx";
import { parseDate, parseNumber } from "../parse";
import styles from "./FieldInputs.module.css";

type TextProps = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & { quiet?: boolean };

/**
 * A text box over a typed value. What's typed stays as typed until it can be
 * read; then the value changes. Leaving the box shows the value tidied up.
 */
function ParsedInput<T>(props: TextProps & {
  value: T | null;
  format: (v: T) => string;
  parse: (s: string) => T | null | undefined;
  onChange: (v: T | null) => void;
}) {
  const { value, format, parse, onChange, quiet, className, ...rest } = props;
  const shown = value === null || value === undefined ? "" : format(value);
  const [text, setText] = useState(shown);
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setText(shown); }, [shown, focused]);
  const bad = parse(text) === undefined;
  return (
    <input
      {...rest}
      className={cx(quiet && styles.quiet, bad && styles.bad, className)}
      value={text}
      aria-invalid={bad || undefined}
      onFocus={() => setFocused(true)}
      onBlur={() => { setFocused(false); setText(shown); }}
      onChange={(e) => {
        setText(e.target.value);
        const v = parse(e.target.value);
        if (v !== undefined) onChange(v);
      }}
    />
  );
}

export function DateInput(props: TextProps & { value: string | null; onChange: (v: string | null) => void }) {
  return <ParsedInput<string> placeholder="YYYY-MM-DD" {...props} format={(v) => v} parse={parseDate} />;
}

export function NumberInput(props: TextProps & { value: number | null; onChange: (v: number | null) => void; money?: boolean }) {
  const { money, ...rest } = props;
  return (
    <ParsedInput<number>
      inputMode="decimal"
      {...rest}
      format={(v) => (money ? v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : String(v))}
      parse={parseNumber}
    />
  );
}

export const quietClass = styles.quiet;
