// One Durable Object per block instance. It owns the block's data: cached query
// results (keyed rows), state, the outgoing change stream with offsets, poll
// alarms, and the sockets of whoever is viewing. The block's own code runs in a
// Worker Loader isolate with no bindings and no network; this DO does all I/O.
import { DurableObject } from "cloudflare:workers";
import { fanout, gateway, registry, type Env } from "./env";
import { loadIsolate } from "./isolate";
import { topicsFor, type Grant } from "./gateway-do";
import type { BlockRecord, ModuleVersion } from "./registry-do";

interface QuerySpec {
  name: string;
  tool: string;
  args: unknown;
  key: string;
  refreshMs: number | null;
}
interface ActionSpec {
  name: string;
  tool: string;
  invalidates: string[];
  permission: "read" | "write" | "confirm";
}
interface Evaluation {
  id: string;
  tools: string[];
  queries: QuerySpec[];
  actions: ActionSpec[];
  describe: string | null;
  stateDefaults: Record<string, unknown>;
  errors: string[];
}
type Status = "pending" | "waiting" | "ready" | "error";
interface QueryValue {
  rows: any[];
  status: Status;
  args?: unknown;
  fetchedAt?: number;
  error?: string;
  key?: string;
}
type Op = { op: "insert" | "update" | "delete"; key: string; value?: unknown };

const LOG_SIZE = 200;
const MAX_PASSES = 5; // dependent queries settle within a few evaluations

function diff(oldRows: any[], newRows: any[], key: string): Op[] {
  const before = new Map(oldRows.map((r) => [String(r[key]), r]));
  const ops: Op[] = [];
  for (const r of newRows) {
    const k = String(r[key]);
    const prev = before.get(k);
    if (!prev) ops.push({ op: "insert", key: k, value: r });
    else if (JSON.stringify(prev) !== JSON.stringify(r)) ops.push({ op: "update", key: k, value: r });
    before.delete(k);
  }
  for (const k of before.keys()) ops.push({ op: "delete", key: k });
  return ops;
}

export class BlockDO extends DurableObject<Env> {
  private offset = 0;
  private log: { offset: number; [k: string]: unknown }[] = [];
  private ev: Evaluation | null = null;
  private versionCache: ModuleVersion | null = null;
  // Webhooks, alarms, actions and state edits can arrive while a refetch is in
  // flight; run them one at a time so values and offsets stay consistent.
  private chain: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.offset = (await ctx.storage.get<number>("offset")) ?? 0;
    });
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  // ---- records ---------------------------------------------------------------

  private async record() {
    const rec = await this.ctx.storage.get<BlockRecord>("record");
    if (!rec) throw new Error("block not initialized");
    return rec;
  }

  private async version() {
    const rec = await this.record();
    if (this.versionCache?.id !== rec.versionId) {
      this.versionCache = await registry(this.env).getVersion(rec.versionId);
      if (!this.versionCache) throw new Error(`version ${rec.versionId} not found`);
    }
    return this.versionCache;
  }

  private async values() {
    return (await this.ctx.storage.get<Record<string, QueryValue>>("values")) ?? {};
  }

  private async state(ev?: Evaluation) {
    const stored = (await this.ctx.storage.get<Record<string, unknown>>("state")) ?? {};
    return { ...(ev?.stateDefaults ?? this.ev?.stateDefaults ?? {}), ...stored };
  }

  // ---- the isolate -----------------------------------------------------------

  private async isolate() {
    return loadIsolate(this.env, (await this.version()).compiled.server);
  }

  private async evaluate(): Promise<Evaluation> {
    const rec = await this.record();
    const values = await this.values();
    const snapValues = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { rows: v.rows, status: v.status }]));
    const ep = await this.isolate();
    const ev: Evaluation = await ep.evaluate({ props: rec.props, state: await this.state(), values: snapValues });
    return ev;
  }

  // ---- the change stream -----------------------------------------------------

  private push(msg: Record<string, unknown>) {
    const entry = { offset: ++this.offset, ...msg };
    this.log.push(entry);
    if (this.log.length > LOG_SIZE) this.log.shift();
    void this.ctx.storage.put("offset", this.offset);
    const text = JSON.stringify(entry);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(text);
      } catch {}
    }
  }

  private async snapshot() {
    const rec = await this.record();
    const v = await this.version();
    const ev = this.ev ?? (await this.evaluate());
    return {
      type: "snapshot",
      offset: this.offset,
      block: { id: rec.id, module: v.manifest.id, client: v.compiled.client },
      values: await this.values(),
      state: await this.state(ev),
      describe: ev.describe,
      errors: ev.errors,
      actions: ev.actions,
    };
  }

  // ---- reconciling: evaluate, fetch what changed, repeat ----------------------

  private async reconcile(force: Set<string> = new Set()) {
    const rec = await this.record();
    let ev = await this.evaluate();
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const values = await this.values();
      for (const q of ev.queries) {
        if (q.args == null && values[q.name]?.status !== "waiting") {
          values[q.name] = { rows: [], status: "waiting" };
          this.push({ type: "change", query: q.name, ops: [], status: "waiting" });
        }
      }
      await this.ctx.storage.put("values", values);
      const due = ev.queries.filter((q) => {
        if (q.args == null) return false;
        const v = values[q.name];
        // An error is settled until its args change or someone forces a refetch.
        const settled = v && (v.status === "ready" || v.status === "error") && JSON.stringify(v.args) === JSON.stringify(q.args);
        return force.has(q.name) || !settled;
      });
      if (!due.length) break;
      const grant: Grant = { blockId: rec.id, principal: rec.principal, tools: ev.tools };
      // Fetch in parallel, then write once: separate read-modify-writes would clobber each other.
      const results = await Promise.all(due.map((q) => this.fetchQuery(q, grant, values[q.name])));
      for (const { name, value, msg } of results) {
        values[name] = value;
        if (msg) this.push(msg);
      }
      await this.ctx.storage.put("values", values);
      force = new Set();
      ev = await this.evaluate(); // results may change describe or dependent args
    }

    const changed = JSON.stringify(this.ev && { d: this.ev.describe, e: this.ev.errors, a: this.ev.actions }) !==
      JSON.stringify({ d: ev.describe, e: ev.errors, a: ev.actions });
    this.ev = ev;
    if (changed) this.push({ type: "meta", describe: ev.describe, errors: ev.errors, actions: ev.actions });

    const topics = [...new Set(ev.queries.flatMap((q) => (q.args == null ? [] : topicsFor(q.tool, q.args))))];
    const prev = await this.ctx.storage.get<string[]>("topics");
    if (JSON.stringify(prev) !== JSON.stringify(topics)) {
      await registry(this.env).setSubscriptions(rec.id, topics);
      await this.ctx.storage.put("topics", topics);
    }
    await this.scheduleAlarm();
  }

  private async fetchQuery(q: QuerySpec, grant: Grant, old: QueryValue | undefined) {
    try {
      const { result } = await gateway(this.env).call(grant, q.tool, q.args);
      const rows = Array.isArray(result) ? result : [{ id: "value", ...(result as object) }];
      const ops = diff(old?.rows ?? [], rows, q.key);
      const fetchedAt = Date.now();
      const value: QueryValue = { rows, status: "ready", args: q.args, fetchedAt, key: q.key };
      const changed = ops.length || old?.status !== "ready";
      return { name: q.name, value, msg: changed ? { type: "change", query: q.name, ops, status: "ready", fetchedAt } : null };
    } catch (e: any) {
      const value: QueryValue = { rows: old?.rows ?? [], status: "error", args: q.args, error: e.message, key: q.key };
      return { name: q.name, value, msg: { type: "change", query: q.name, ops: [], status: "error", error: e.message } };
    }
  }

  // ---- polling: only while someone is watching -------------------------------

  private observed() {
    return this.ctx.getWebSockets().length > 0;
  }

  private async scheduleAlarm() {
    const polled = (this.ev?.queries ?? []).filter((q) => q.refreshMs && q.args != null);
    if (!polled.length || !this.observed()) return;
    const values = await this.values();
    const next = Math.min(...polled.map((q) => (values[q.name]?.fetchedAt ?? 0) + q.refreshMs!));
    const current = await this.ctx.storage.getAlarm();
    if (current == null || current > next) await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 250));
  }

  async alarm() {
    if (!this.observed()) return; // nobody watching: stop polling, let the DO sleep
    await this.serial(async () => {
      const values = await this.values();
      const now = Date.now();
      const due = (this.ev?.queries ?? []).filter((q) => q.refreshMs && now - (values[q.name]?.fetchedAt ?? 0) >= q.refreshMs - 50);
      await this.reconcile(new Set(due.map((q) => q.name)));
    });
  }

  // ---- RPC from the worker ---------------------------------------------------

  async init(rec: BlockRecord) {
    return this.serial(async () => {
      await this.ctx.storage.put("record", rec);
      await this.ctx.storage.delete(["values", "state", "topics"]);
      this.ev = null;
      this.versionCache = null;
      await this.reconcile();
      return this.ev!.describe;
    });
  }

  /** A webhook touched these topics: refetch the queries that registered them. */
  async notify(topics: string[]) {
    return this.serial(async () => {
      const ev = this.ev ?? (await this.evaluate());
      const hit = ev.queries.filter((q) => q.args != null && topicsFor(q.tool, q.args).some((t) => topics.includes(t)));
      if (hit.length) await this.reconcile(new Set(hit.map((q) => q.name)));
      return hit.map((q) => q.name);
    });
  }

  async refresh() {
    return this.serial(async () => {
      const ev = this.ev ?? (await this.evaluate());
      await this.reconcile(new Set(ev.queries.map((q) => q.name)));
    });
  }

  async setState(key: string, value: unknown) {
    return this.serial(async () => {
      const stored = (await this.ctx.storage.get<Record<string, unknown>>("state")) ?? {};
      stored[key] = value;
      await this.ctx.storage.put("state", stored);
      this.push({ type: "state", key, value });
      await this.reconcile();
    });
  }

  async runAction(name: string, input: any, opts: { confirmed?: boolean } = {}) {
    const topics = await this.serial(async () => {
      const rec = await this.record();
      const ev = this.ev ?? (await this.evaluate());
      const action = ev.actions.find((a) => a.name === name);
      if (!action) throw new Error(`no action ${name}`);
      if (action.permission === "confirm" && !opts.confirmed) throw new Error(`${name} needs confirmation`);
      const grant: Grant = { blockId: rec.id, principal: rec.principal, tools: ev.tools };
      const { result, topics } = await gateway(this.env).call(grant, action.tool, input);
      // Single flight: refetch what this action invalidates before replying.
      await this.reconcile(new Set(action.invalidates));
      return { result, topics };
    });
    // Other blocks hear about it the way they'd hear a webhook.
    this.ctx.waitUntil(fanout(this.env, topics.topics, (await this.record()).id));
    return topics.result;
  }

  /** What an agent reads: the describe line plus an outline of where each value came from. */
  async describeBlock() {
    const rec = await this.record();
    const v = await this.version();
    const ev = this.ev ?? (await this.evaluate());
    const values = await this.values();
    return {
      id: rec.id,
      module: v.manifest.id,
      principal: rec.principal,
      describe: ev.describe,
      errors: ev.errors,
      outline: ev.queries.map((q) => ({
        query: q.name,
        tool: q.tool,
        args: q.args,
        status: values[q.name]?.status ?? "pending",
        rows: values[q.name]?.rows.length ?? 0,
        fetchedAt: values[q.name]?.fetchedAt ?? null,
        freshness: q.refreshMs ? `polled every ${q.refreshMs / 1000}s while observed` : topicsFor(q.tool, q.args).length ? `live via ${topicsFor(q.tool, q.args).join(", ")}` : "fetched on change",
        error: values[q.name]?.error,
      })),
      actions: ev.actions,
      state: await this.state(ev),
      viewers: this.ctx.getWebSockets().length,
      offset: this.offset,
      sandbox: await (await this.isolate()).probe(),
    };
  }

  // ---- viewers ---------------------------------------------------------------

  async fetch(req: Request) {
    if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const since = Number(new URL(req.url).searchParams.get("since") ?? NaN);
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    // Resume from an offset if the log still has it; otherwise start from a snapshot.
    const first = this.log[0]?.offset;
    if (Number.isFinite(since) && first != null && since >= first - 1 && since <= this.offset) {
      for (const entry of this.log) if (entry.offset > since) server.send(JSON.stringify(entry));
    } else {
      server.send(JSON.stringify(await this.serial(() => this.snapshot())));
    }
    await this.scheduleAlarm(); // a viewer arrived: polling resumes
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    const msg = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data));
    try {
      if (msg.type === "action") {
        const result = await this.runAction(msg.name, msg.input, { confirmed: msg.confirmed });
        ws.send(JSON.stringify({ type: "ack", id: msg.id, ok: true, result }));
      } else if (msg.type === "setState") {
        await this.setState(msg.key, msg.value);
      } else if (msg.type === "refresh") {
        await this.refresh();
      }
    } catch (e: any) {
      ws.send(JSON.stringify({ type: "ack", id: msg.id, ok: false, error: e.message }));
    }
  }

  async webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code, "closing");
    } catch {}
  }
}
