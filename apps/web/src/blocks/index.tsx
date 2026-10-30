import { useEffect, useRef, useState } from "react";
import { createBlockRegistry, defineBlock, useBlock, useLinkPublish, useLinkValue, type BlockProps } from "@mason/react";
import { allDocs, allSessions, saveDoc, sendMessage, useAllSessions, useDoc, useSession } from "../inspectApi";

type SessionState = { sessionId: string };
type MaybeSession = { sessionId?: string };

/** Use the explicit sessionId if the block has one, else follow its link group. */
function useSessionTarget(state: MaybeSession) {
  const linked = useLinkValue<string>("session");
  return state.sessionId ?? linked;
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="b-empty">{children}</div>;
}

// ---------------------------------------------------------------------------

function DocBlock({ state }: BlockProps<{ docId: string }>) {
  const doc = useDoc(state.docId);
  const block = useBlock();
  useEffect(() => {
    if (doc) block.setTitle(doc.title);
  }, [doc?.title]);
  if (!doc) return <Empty>Doc not found.</Empty>;
  return <textarea className="b-doc" value={doc.body} onChange={(e) => saveDoc(doc.id, e.target.value)} spellCheck={false} />;
}

function SessionBlock({ state }: BlockProps<SessionState>) {
  const session = useSession(state.sessionId);
  const sessions = useAllSessions();
  const block = useBlock();
  const [draft, setDraft] = useState(""); // local React state: survives drags and splits
  const end = useRef<HTMLDivElement>(null);
  useLinkPublish("session", state.sessionId);
  useEffect(() => {
    if (session) block.setTitle(session.name);
  }, [session?.name]);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [session?.messages]);
  if (!session) return <Empty>Session not found.</Empty>;
  const childCount = Object.values(sessions).filter((s) => s.parentId === session.id).length;
  return (
    <div className="b-session">
      <div className="b-toolbar">
        <span className={`b-status b-status-${session.status}`}>{session.status}</span>
        <span className="b-spacer" />
        {/* block.open: ask the layout to show another block next to this one */}
        <button onClick={() => block.open({ kind: "inspect.session.diffs", state: { sessionId: session.id } }, { placement: "down", reuse: true })}>
          Diffs ({session.diffs.length})
        </button>
        <button onClick={() => block.open({ kind: "inspect.session.children", state: { sessionId: session.id } }, { placement: "left", reuse: true })}>
          Children ({childCount})
        </button>
        <button onClick={() => block.open({ kind: "inspect.preview", state: { sessionId: session.id } }, { placement: "right", reuse: true })}>
          Preview
        </button>
      </div>
      <div className="b-messages">
        {session.messages.map((m, i) =>
          m.role === "context" ? (
            // What the agent was given this turn: composed from the blocks around it.
            <details key={i} className="b-context">
              <summary>Context from {m.text.match(/\((\d+)\)/)?.[1] ?? 0} blocks around this agent</summary>
              <pre>{m.text}</pre>
            </details>
          ) : m.role === "tool" ? (
            <div key={i} className="b-tool">
              ⚙ {m.text}
            </div>
          ) : (
            <div key={i} className={`b-msg b-msg-${m.role}`}>
              {m.text || "…"}
            </div>
          ),
        )}
        <div ref={end} />
      </div>
      <form
        className="b-composer"
        onSubmit={(e) => {
          e.preventDefault();
          if (!draft.trim()) return;
          sendMessage(session.id, draft.trim(), block.id);
          setDraft("");
        }}
      >
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Message the agent…" />
      </form>
    </div>
  );
}

function DiffsBlock({ state }: BlockProps<MaybeSession>) {
  const sessionId = useSessionTarget(state);
  const session = useSession(sessionId);
  const block = useBlock();
  useEffect(() => {
    block.setTitle(session ? `Diffs · ${session.name}` : "Diffs");
  }, [session?.name]);
  if (!session) return <Empty>Link this block to a session (click the dot in its tab), or open it from a session.</Empty>;
  return (
    <ul className="b-list">
      {session.diffs.map((d) => (
        <li key={d.path}>
          <button onClick={() => block.open({ kind: "inspect.diff", state: { sessionId: session.id, path: d.path } }, { placement: "tab", reuse: true })}>
            <code>{d.path}</code>
            <span className="b-add">+{d.added}</span>
            <span className="b-del">−{d.removed}</span>
          </button>
        </li>
      ))}
      {!session.diffs.length && <Empty>No changes yet.</Empty>}
    </ul>
  );
}

function DiffBlock({ state }: BlockProps<{ sessionId: string; path: string }>) {
  const session = useSession(state.sessionId);
  const diff = session?.diffs.find((d) => d.path === state.path);
  const block = useBlock();
  useEffect(() => {
    block.setTitle(state.path.split("/").pop()!);
  }, [state.path]);
  if (!diff) return <Empty>No diff for {state.path}.</Empty>;
  return (
    <pre className="b-patch">
      {diff.patch.split("\n").map((l, i) => (
        <div key={i} className={l.startsWith("+") ? "b-add" : l.startsWith("-") ? "b-del" : ""}>
          {l}
        </div>
      ))}
    </pre>
  );
}

function ChildSessionsBlock({ state }: BlockProps<MaybeSession>) {
  const sessionId = useSessionTarget(state);
  const sessions = useAllSessions();
  const parent = sessionId ? sessions[sessionId] : undefined;
  const block = useBlock();
  useEffect(() => {
    block.setTitle(parent ? `Children · ${parent.name}` : "Child sessions");
  }, [parent?.name]);
  if (!parent) return <Empty>Link this block to a session.</Empty>;
  const children = Object.values(sessions).filter((s) => s.parentId === parent.id);
  return (
    <ul className="b-list">
      {children.map((c) => (
        <li key={c.id}>
          {/* Opens beside this block, or focuses it if it's already open in this space */}
          <button onClick={() => block.open({ kind: "inspect.session", state: { sessionId: c.id } }, { placement: "right", reuse: true })}>
            <span className={`b-status b-status-${c.status}`}>{c.status}</span> {c.name}
          </button>
        </li>
      ))}
      {!children.length && <Empty>No child sessions.</Empty>}
    </ul>
  );
}

function PreviewBlock({ state }: BlockProps<MaybeSession>) {
  const sessionId = useSessionTarget(state);
  const session = useSession(sessionId);
  const block = useBlock();
  const [clicks, setClicks] = useState(0); // local state; drag this block around and it stays
  const [mountedAt] = useState(() => new Date().toLocaleTimeString());
  useEffect(() => {
    block.setTitle(session ? `Preview · ${session.name}` : "Preview");
  }, [session?.name]);
  if (!session) return <Empty>Link this block to a session to preview it.</Empty>;
  const last = session.diffs[session.diffs.length - 1];
  return (
    <div className="b-preview">
      <div className="b-url">{session.previewUrl}</div>
      <div className="b-page">
        <h2>{session.name}</h2>
        <p>
          {session.diffs.length} changed files · latest <code>{last?.path ?? "none"}</code>
        </p>
        <button className="b-cta" onClick={() => setClicks((c) => c + 1)}>
          Clicked {clicks} times
        </button>
        <p className="b-dim">
          Mounted at {mountedAt}. {block.isVisible ? "Visible" : "Hidden"}. Move this block around: the counter and mount time stay, because
          blocks never remount.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

export const registry = createBlockRegistry([
  defineBlock({
    kind: "inspect.doc",
    name: "Doc",
    icon: "📄",
    component: DocBlock,
    launch: () => allDocs().map((d) => ({ label: d.title, state: { docId: d.id } })),
  }),
  defineBlock({
    kind: "inspect.session",
    name: "Session",
    icon: "💬",
    component: SessionBlock,
    launch: () => allSessions().map((s) => ({ label: s.name, state: { sessionId: s.id } })),
  }),
  defineBlock({
    kind: "inspect.session.diffs",
    name: "Diffs",
    icon: "±",
    component: DiffsBlock,
    launch: () => [{ label: "follows linked session", state: {} }],
  }),
  defineBlock({ kind: "inspect.diff", name: "Diff", icon: "±", component: DiffBlock }),
  defineBlock({
    kind: "inspect.session.children",
    name: "Child sessions",
    icon: "🌿",
    component: ChildSessionsBlock,
    launch: () => [{ label: "follows linked session", state: {} }],
  }),
  defineBlock({
    kind: "inspect.preview",
    name: "Preview",
    icon: "▶",
    component: PreviewBlock,
    launch: () => [{ label: "follows linked session", state: {} }],
  }),
]);
