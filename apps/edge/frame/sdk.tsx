// @mason/sdk as seen by a block's view, inside its sandboxed iframe. Bundled with
// React into one ES module served at /runtime/sdk.js; the frame's import map points
// "@mason/sdk", "@mason/sdk/jsx-runtime" and "react" at it.
//
// The frame's only channel is the MessagePort the host hands it. It materializes
// the block's change stream (snapshot + keyed row ops) and renders the view.
import { Component, useSyncExternalStore, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

export { jsx, jsxs, Fragment } from "react/jsx-runtime";
export { useState, useMemo, useEffect, useRef, useCallback } from "react";

type Status = "pending" | "waiting" | "ready" | "error";
interface QueryState {
  rows: Map<string, any>;
  status: Status;
  fetchedAt?: number;
  error?: string;
}

let def: any = null;
export const Block = {
  define(d: any) {
    def = d;
    return d;
  },
};

// ---- the materialized store ---------------------------------------------------

const store = {
  offset: 0,
  queries: {} as Record<string, QueryState>,
  state: {} as Record<string, unknown>,
  describe: null as string | null,
  errors: [] as string[],
  version: 0,
};
const listeners = new Set<() => void>();
const emit = () => {
  store.version++;
  listeners.forEach((l) => l());
};

function apply(msg: any) {
  if (msg.type === "snapshot") {
    store.queries = {};
    for (const [name, v] of Object.entries<any>(msg.values)) {
      store.queries[name] = { rows: new Map(v.rows.map((r: any) => [String(r[v.key ?? "id"]), r])), status: v.status, fetchedAt: v.fetchedAt, error: v.error };
    }
    store.state = msg.state;
    store.describe = msg.describe;
    store.errors = msg.errors;
  } else if (msg.type === "change") {
    const q = (store.queries[msg.query] ??= { rows: new Map(), status: "pending" });
    for (const op of msg.ops) {
      if (op.op === "delete") q.rows.delete(op.key);
      else q.rows.set(op.key, op.value);
    }
    q.status = msg.status;
    q.fetchedAt = msg.fetchedAt ?? q.fetchedAt;
    q.error = msg.error;
  } else if (msg.type === "state") {
    store.state = { ...store.state, [msg.key]: msg.value };
  } else if (msg.type === "meta") {
    store.describe = msg.describe;
    store.errors = msg.errors;
  } else return;
  if (typeof msg.offset === "number") store.offset = msg.offset;
  emit();
}

// ---- host channel -------------------------------------------------------------

let port: MessagePort | null = null;
let nextId = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

function send(msg: unknown) {
  port?.postMessage(msg);
}

function act(name: string, input: unknown, opts: { confirmed?: boolean } = {}) {
  const id = ++nextId;
  send({ type: "action", id, name, input, confirmed: opts.confirmed });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

function useModel() {
  useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => store.version,
  );
  const data: Record<string, any[]> = {};
  const status: Record<string, Status> = {};
  for (const [name, q] of Object.entries(store.queries)) {
    data[name] = [...q.rows.values()];
    status[name] = q.status;
  }
  return {
    data,
    status,
    errors: Object.fromEntries(Object.entries(store.queries).filter(([, q]) => q.error).map(([n, q]) => [n, q.error!])),
    state: store.state,
    setState: (key: string, value: unknown) => send({ type: "setState", key, value }),
    act,
    refresh: () => send({ type: "refresh" }),
  };
}

class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    send({ type: "error", message: error.message });
  }
  render() {
    return this.state.error ? <pre className="m-error">View crashed: {this.state.error.message}</pre> : this.props.children;
  }
}

function Root() {
  const model = useModel();
  const View = def?.view;
  if (!View) return <p className="m-muted">This block has no view.</p>;
  return <View {...model} />;
}

export function boot() {
  window.addEventListener("message", (e) => {
    if (e.data?.type !== "mason:init" || !e.ports[0] || port) return;
    port = e.ports[0];
    port.onmessage = (ev) => {
      const msg = ev.data;
      if (msg.type === "ack") {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (p) msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error));
      } else apply(msg);
    };
    createRoot(document.getElementById("root")!).render(
      <Boundary>
        <Root />
      </Boundary>,
    );
    new ResizeObserver(() => send({ type: "size", height: document.documentElement.scrollHeight })).observe(document.body);
    send({ type: "ready" });
  });
}

// ---- @mason/ui: a few themed pieces so views look consistent -----------------

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="m-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: "good" | "warn" | "bad" }) {
  return (
    <div className={`m-stat ${tone ?? ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function Badge({ tone, children }: { tone?: "good" | "warn" | "bad"; children: ReactNode }) {
  return <span className={`m-badge ${tone ?? ""}`}>{children}</span>;
}

export function Table<T>({ rows, columns, empty }: { rows: T[]; columns: { label: string; render: (r: T) => ReactNode }[]; empty?: string }) {
  if (!rows.length) return <p className="m-muted">{empty ?? "Nothing here."}</p>;
  return (
    <table className="m-table">
      <thead>
        <tr>{columns.map((c) => <th key={c.label}>{c.label}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>{columns.map((c) => <td key={c.label}>{c.render(r)}</td>)}</tr>
        ))}
      </tbody>
    </table>
  );
}
