import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useAppData } from "../data";
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

/** Ask questions about the archive; answers cite the documents they come from. */
export function AskPage() {
  const { status } = useAppData();
  const [question, setQuestion] = useState("");
  const [history, setHistory] = useState<Exchange[]>([]);
  const [busy, setBusy] = useState(false);

  const ask = async (q: string) => {
    if (!q.trim() || busy) return;
    setBusy(true);
    setQuestion("");
    setHistory((h) => [{ question: q }, ...h]);
    try {
      const response = await api.ask(q);
      setHistory((h) => [{ question: q, response }, ...h.slice(1)]);
    } catch (e) {
      setHistory((h) => [{ question: q, error: (e as Error).message }, ...h.slice(1)]);
    } finally {
      setBusy(false);
    }
  };

  if (status && !status.ai) {
    return <div className="page narrow"><h2>Ask</h2><p className="muted">Ask needs AI. Set ANTHROPIC_API_KEY to turn it on.</p></div>;
  }

  return (
    <div className="page narrow ask">
      <h2>Ask</h2>
      <p className="muted">Questions about your documents. Answers link to the documents they come from; each question is answered on its own.</p>
      <form onSubmit={(e) => { e.preventDefault(); void ask(question); }}>
        <textarea
          rows={2}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void ask(question); } }}
          placeholder="e.g. What did the plumber fix, and did I pay it?"
          autoFocus
        />
        <div className="actions">
          <button className="primary" disabled={busy || !question.trim()}>{busy ? "Looking…" : "Ask"}</button>
          {history.length === 0 &&
            EXAMPLES.map((ex) => <button type="button" key={ex} className="link small" onClick={() => void ask(ex)}>{ex}</button>)}
        </div>
      </form>

      {history.map((x, i) => (
        <div className="exchange" key={history.length - i}>
          <div className="question">{x.question}</div>
          {!x.response && !x.error && <p className="muted status analyzing">Searching your documents…</p>}
          {x.error && <div className="alert error">{x.error}</div>}
          {x.response && <Answer response={x.response} />}
        </div>
      ))}
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
      if (n) parts.push(<Link key={`${key}-${m.index}`} className="cite" to={`/documents/${m[1]}`}>{n}</Link>);
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
    <div className="answer">
      {blocks}
      {response.citations.length > 0 && (
        <ol className="citations">
          {response.citations.map((c) => (
            <li key={c.id}><Link to={`/documents/${c.id}`}>{c.title}</Link>{c.documentDate && <span className="muted small"> · {c.documentDate}</span>}</li>
          ))}
        </ol>
      )}
      {response.steps.length > 0 && (
        <details className="small muted">
          <summary>How this was found ({response.steps.length} step{response.steps.length === 1 ? "" : "s"})</summary>
          <ul>{response.steps.map((s, i) => <li key={i}>{s}</li>)}</ul>
        </details>
      )}
    </div>
  );
}
