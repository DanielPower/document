import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { cx } from "../cx";
import { useAppData } from "../data";
import ui from "../ui.module.css";
import styles from "./Ask.module.css";
import type { AskResponse } from "../types";

interface Exchange {
  question: string;
  response?: AskResponse;
  error?: string;
}

const EXAMPLES = [
  "When does my home insurance renew, and what's the deductible?",
  "How much have I spent on the car this year?",
  "Which bills are still unpaid?",
];

const STORE = "docket.ask";

/** The conversation survives leaving the page and reloading, on this device. */
function loadHistory(): Exchange[] {
  try {
    const h = JSON.parse(localStorage.getItem(STORE) ?? "[]") as Exchange[];
    return Array.isArray(h) ? h.filter((x) => x.response || x.error) : [];
  } catch {
    return [];
  }
}

/**
 * Ask questions about the archive; answers cite the documents they come from.
 * Questions in one conversation are follow-ups: the assistant sees the
 * earlier questions and answers.
 */
export function AskPage() {
  const { status } = useAppData();
  const [question, setQuestion] = useState("");
  const [history, setHistory] = useState<Exchange[]>(loadHistory);
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const [params, setParams] = useSearchParams();

  useEffect(() => {
    localStorage.setItem(STORE, JSON.stringify(history.filter((x) => x.response || x.error).slice(-20)));
  }, [history]);

  const ask = async (q: string) => {
    if (!q.trim() || busy) return;
    // Earlier answered turns are the context for this one.
    const context = history.filter((x) => x.response).map((x) => ({ question: x.question, answer: x.response!.answer }));
    setBusy(true);
    setQuestion("");
    setHistory((h) => [...h, { question: q }]);
    requestAnimationFrame(() => end.current?.scrollIntoView({ behavior: "smooth", block: "end" }));
    try {
      const response = await api.ask(q, context);
      setHistory((h) => [...h.slice(0, -1), { question: q, response }]);
    } catch (e) {
      setHistory((h) => [...h.slice(0, -1), { question: q, error: (e as Error).message }]);
    } finally {
      setBusy(false);
    }
  };

  // A question sent from the search box (/ask?q=…) is asked straight away.
  const pending = params.get("q");
  useEffect(() => {
    if (!pending || !status?.ai) return;
    setParams({}, { replace: true });
    void ask(pending);
  }, [pending, status?.ai]); // eslint-disable-line react-hooks/exhaustive-deps

  if (status && !status.ai) {
    return <div className={cx(ui.page, ui.narrow)}><h2>Ask</h2><p className={ui.muted}>Ask needs AI. Set ANTHROPIC_API_KEY to turn it on.</p></div>;
  }

  return (
    <div className={cx(ui.page, ui.narrow)}>
      <div className={styles.head}>
        <h2>Ask</h2>
        <span className={ui.spacer} />
        {history.length > 0 && (
          <button className={ui.compact} disabled={busy} onClick={() => setHistory([])}>New conversation</button>
        )}
      </div>
      <p className={ui.muted}>
        Questions about your documents. Answers link to the documents they come from
        {history.length ? ", and you can ask follow-ups like “and last year?”" : ""}.
      </p>

      {history.map((x, i) => (
        <div className={styles.exchange} key={i}>
          <div className={styles.question}>{x.question}</div>
          {!x.response && !x.error && <p className={cx(ui.muted, ui.pulse)}>Searching your documents…</p>}
          {x.error && <div className={cx(ui.alert, ui.error)}>{x.error}</div>}
          {x.response && <Answer response={x.response} />}
        </div>
      ))}

      <form className={styles.form} onSubmit={(e) => { e.preventDefault(); void ask(question); }}>
        <textarea
          rows={2}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void ask(question); } }}
          placeholder={history.length ? "Ask a follow-up…" : "e.g. What did the plumber fix, and did I pay it?"}
          autoFocus
        />
        <div className={cx(ui.actions, styles.actions)}>
          <button className={ui.primary} disabled={busy || !question.trim()}>{busy ? "Looking…" : "Ask"}</button>
          {history.length === 0 &&
            EXAMPLES.map((ex) => <button type="button" key={ex} className={cx(ui.link, ui.small)} onClick={() => void ask(ex)}>{ex}</button>)}
        </div>
      </form>
      <div ref={end} />
    </div>
  );
}

function Answer({ response }: { response: AskResponse }) {
  const number = new Map(response.citations.map((c, i) => [c.id, i + 1]));
  const renderLine = (line: string, key: number): ReactNode => {
    const parts: ReactNode[] = [];
    let last = 0;
    for (const m of line.matchAll(/\[\[doc:([0-9a-f-]{36})\]\]/gi)) {
      parts.push(line.slice(last, m.index));
      const n = number.get(m[1]);
      if (n) parts.push(<Link key={`${key}-${m.index}`} className={styles.cite} to={`/documents/${m[1]}`}>{n}</Link>);
      last = m.index! + m[0].length;
    }
    parts.push(line.slice(last));
    return parts;
  };
  // Plain text with "- " bullets: group consecutive bullet lines into a list.
  const blocks: ReactNode[] = [];
  let bullets: string[] = [];
  const flush = () => {
    if (bullets.length) blocks.push(<ul key={`ul${blocks.length}`}>{bullets.map((b, i) => <li key={i}>{renderLine(b, i)}</li>)}</ul>);
    bullets = [];
  };
  response.answer.split("\n").forEach((line, i) => {
    const t = line.trim();
    if (/^[-*•] /.test(t)) bullets.push(t.slice(2));
    else {
      flush();
      if (t) blocks.push(<p key={`p${i}`}>{renderLine(t, i)}</p>);
    }
  });
  flush();

  return (
    <div className={styles.answer}>
      {blocks}
      {response.citations.length > 0 && (
        <ol className={styles.citations}>
          {response.citations.map((c) => (
            <li key={c.id}><Link to={`/documents/${c.id}`}>{c.title}</Link>{c.documentDate && <span className={cx(ui.muted, ui.small)}> · {c.documentDate}</span>}</li>
          ))}
        </ol>
      )}
      {response.steps.length > 0 && (
        <details className={cx(ui.small, ui.muted)}>
          <summary>How this was found ({response.steps.length} step{response.steps.length === 1 ? "" : "s"})</summary>
          <ul>{response.steps.map((s, i) => <li key={i}>{s}</li>)}</ul>
        </details>
      )}
    </div>
  );
}
