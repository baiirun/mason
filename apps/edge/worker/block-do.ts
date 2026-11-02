// One Durable Object per block instance. It owns the block's data: cached query
// results (keyed rows), state, the outgoing change stream with offsets, poll
// alarms, and the sockets of whoever is viewing. The block's own code runs in a
// Worker Loader isolate with no bindings and no network; this DO does all I/O.
//
// The work runs on Effect: one semaphore serializes changes (webhooks, alarms,
// actions and state edits can arrive while a refetch is in flight), tool calls
// get timeouts and retries, and failures are typed.
import { DurableObject } from "cloudflare:workers";
import { Effect, Semaphore } from "effect";
import type { Env } from "./env";
import { topicsFor, type Grant } from "./gateway-do";
import type { BlockRecord, ModuleVersion } from "./registry-do";
import { callTool, fanout, Isolates, makeRuntime, NotFound, Refused, Registry, runForCaller, type Runtime } from "./runtime";

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
type Values = Record<string, QueryValue>;

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

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export class BlockDO extends DurableObject<Env> {
  private offset = 0;
  private log: { offset: number; [k: string]: unknown }[] = [];
  private ev: Evaluation | null = null;
  private versionCache: ModuleVersion | null = null;
  private readonly rt: Runtime;
  private readonly lock = Semaphore.makeUnsafe(1);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.rt = makeRuntime(env);
    ctx.blockConcurrencyWhile(async () => {
      this.offset = (await ctx.storage.get<number>("offset")) ?? 0;
    });
  }

  // ---- effects at the edges --------------------------------------------------

  /** Run for an RPC or socket caller; typed failures arrive as an Error with the failure's message. */
  private run<A, E extends { message: string }>(eff: Effect.Effect<A, E, any>) {
    return runForCaller(this.rt, eff);
  }

  /** One change at a time, so values and offsets stay consistent. */
  private locked<A, E, R>(eff: Effect.Effect<A, E, R>) {
    return this.lock.withPermits(1)(eff);
  }

  private get<T>(key: string) {
    return Effect.promise(() => this.ctx.storage.get<T>(key));
  }
  private put(key: string, value: unknown) {
    return Effect.promise(() => this.ctx.storage.put(key, value));
  }

  // ---- records ---------------------------------------------------------------

  private readonly record = Effect.flatMap(
    Effect.promise(() => this.ctx.storage.get<BlockRecord>("record")),
    (rec) => (rec ? Effect.succeed(rec) : Effect.fail(new NotFound({ message: "block not initialized" }))),
  );

  private readonly version = Effect.gen({ self: this }, function* () {
    const rec = yield* this.record;
    if (this.versionCache?.id !== rec.versionId) this.versionCache = yield* (yield* Registry).getVersion(rec.versionId);
    return this.versionCache!;
  });

  private readonly values = Effect.map(this.get<Values>("values"), (v) => v ?? {});

  private state(ev?: Evaluation | null) {
    return Effect.map(this.get<Record<string, unknown>>("state"), (stored) => ({ ...(ev?.stateDefaults ?? this.ev?.stateDefaults ?? {}), ...(stored ?? {}) }));
  }

  // ---- the isolate -----------------------------------------------------------

  private readonly evaluate = Effect.gen({ self: this }, function* () {
    const rec = yield* this.record;
    const values = yield* this.values;
    const snapValues = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { rows: v.rows, status: v.status }]));
    const { compiled } = yield* this.version;
    return (yield* (yield* Isolates).evaluate(compiled.server, { props: rec.props, state: yield* this.state(), values: snapValues })) as Evaluation;
  });

  /** The last evaluation, or a fresh one if this instance hasn't evaluated yet (e.g. after eviction). */
  private readonly current = Effect.suspend(() =>
    this.ev ? Effect.succeed(this.ev) : Effect.tap(this.evaluate, (ev) => Effect.sync(() => void (this.ev ??= ev))),
  );

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

  private readonly snapshot = Effect.gen({ self: this }, function* () {
    const rec = yield* this.record;
    const v = yield* this.version;
    const ev = yield* this.current;
    return {
      type: "snapshot",
      offset: this.offset,
      block: { id: rec.id, module: v.manifest.id, client: v.compiled.client },
      values: yield* this.values,
      state: yield* this.state(ev),
      describe: ev.describe,
      errors: ev.errors,
      actions: ev.actions,
    };
  });

  // ---- reconciling: evaluate, fetch what changed, repeat ----------------------

  private reconcile(force: Set<string> = new Set()) {
    return Effect.gen({ self: this }, function* () {
      const rec = yield* this.record;
      let ev = yield* this.evaluate;
      for (let pass = 0; pass < MAX_PASSES; pass++) {
        const values = yield* this.values;
        for (const q of ev.queries) {
          if (q.args == null && values[q.name]?.status !== "waiting") {
            values[q.name] = { rows: [], status: "waiting" };
            this.push({ type: "change", query: q.name, ops: [], status: "waiting" });
          }
        }
        const due = ev.queries.filter((q) => {
          if (q.args == null) return false;
          const v = values[q.name];
          // An error is settled until its args change or someone forces a refetch.
          const settled = v && (v.status === "ready" || v.status === "error") && same(v.args, q.args);
          return force.has(q.name) || !settled;
        });
        if (!due.length) {
          yield* this.put("values", values);
          break;
        }
        const grant: Grant = { blockId: rec.id, principal: rec.principal };
        // Fetch in parallel, then write once: separate read-modify-writes would clobber each other.
        const results = yield* Effect.forEach(due, (q) => this.fetchQuery(q, grant, values[q.name]), { concurrency: "unbounded" });
        for (const { name, value, msg } of results) {
          values[name] = value;
          if (msg) this.push(msg);
        }
        yield* this.put("values", values);
        force = new Set();
        ev = yield* this.evaluate; // results may change describe or dependent args
      }

      const changed = !same(this.ev && { d: this.ev.describe, e: this.ev.errors, a: this.ev.actions }, { d: ev.describe, e: ev.errors, a: ev.actions });
      this.ev = ev;
      if (changed) this.push({ type: "meta", describe: ev.describe, errors: ev.errors, actions: ev.actions });

      const topics = [...new Set(ev.queries.flatMap((q) => (q.args == null ? [] : topicsFor(q.tool, q.args))))];
      if (!same(yield* this.get<string[]>("topics"), topics)) {
        yield* (yield* Registry).setSubscriptions(rec.id, topics);
        yield* this.put("topics", topics);
      }
      yield* this.scheduleAlarm;
    });
  }

  /** One query's fetch. A failed call becomes the query's error status, not a failed reconcile. */
  private fetchQuery(q: QuerySpec, grant: Grant, old: QueryValue | undefined) {
    return callTool(grant, q.tool, q.args).pipe(
      Effect.map(({ result }) => {
        const rows = Array.isArray(result) ? result : [{ id: "value", ...(result as object) }];
        const ops = diff(old?.rows ?? [], rows, q.key);
        const fetchedAt = Date.now();
        const value: QueryValue = { rows, status: "ready", args: q.args, fetchedAt, key: q.key };
        const changed = ops.length > 0 || old?.status !== "ready";
        return { name: q.name, value, msg: changed ? { type: "change", query: q.name, ops, status: "ready", fetchedAt } : null };
      }),
      Effect.catchTag("ToolError", (e) =>
        Effect.succeed({
          name: q.name,
          value: { rows: old?.rows ?? [], status: "error", args: q.args, error: e.message, key: q.key } as QueryValue,
          msg: { type: "change", query: q.name, ops: [], status: "error", error: e.message },
        }),
      ),
    );
  }

  // ---- polling: only while someone is watching -------------------------------

  private observed() {
    return this.ctx.getWebSockets().length > 0;
  }

  private readonly scheduleAlarm = Effect.gen({ self: this }, function* () {
    if (!this.observed()) return;
    const polled = (yield* this.current).queries.filter((q) => q.refreshMs && q.args != null);
    if (!polled.length || !this.observed()) return;
    const values = yield* this.values;
    const next = Math.min(...polled.map((q) => (values[q.name]?.fetchedAt ?? 0) + q.refreshMs!));
    const current = yield* Effect.promise(() => this.ctx.storage.getAlarm());
    if (current == null || current > next) yield* Effect.promise(() => this.ctx.storage.setAlarm(Math.max(next, Date.now() + 250)));
  });

  async alarm() {
    if (!this.observed()) return; // nobody watching: stop polling, let the DO sleep
    await this.run(
      this.locked(
        Effect.gen({ self: this }, function* () {
          const values = yield* this.values;
          const now = Date.now();
          const due = (yield* this.current).queries.filter((q) => q.refreshMs && now - (values[q.name]?.fetchedAt ?? 0) >= q.refreshMs - 50);
          yield* this.reconcile(new Set(due.map((q) => q.name)));
        }),
      ),
    );
  }

  // ---- RPC from the worker ---------------------------------------------------

  init(rec: BlockRecord) {
    return this.run(
      this.locked(
        Effect.gen({ self: this }, function* () {
          yield* this.put("record", rec);
          yield* Effect.promise(() => this.ctx.storage.delete(["values", "state", "topics"]));
          this.ev = null;
          this.versionCache = null;
          yield* this.reconcile();
          return this.ev!.describe;
        }),
      ),
    );
  }

  /**
   * Switch to a new version or props in place. State and cached rows stay; queries
   * whose args didn't change aren't refetched, and ones the new code dropped are pruned.
   */
  update(rec: BlockRecord) {
    return this.run(
      this.locked(
        Effect.gen({ self: this }, function* () {
          const old = yield* this.record;
          yield* this.put("record", rec);
          this.versionCache = null;
          yield* this.reconcile();
          const keep = new Set(this.ev!.queries.map((q) => q.name));
          const values = yield* this.values;
          const pruned = Object.keys(values).filter((k) => !keep.has(k));
          if (pruned.length) {
            for (const k of pruned) delete values[k];
            yield* this.put("values", values);
          }
          if (old.versionId !== rec.versionId) {
            const v = yield* this.version;
            // Viewers reload the iframe with the new client bundle, then resync.
            this.push({ type: "version", versionId: v.id, client: v.compiled.client });
          }
          return this.ev!.describe;
        }),
      ),
    );
  }

  /** Removed from the canvas: close viewers and drop everything. */
  async destroy() {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1000, "block removed");
      } catch {}
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.ev = null;
    this.log = [];
  }

  /** A webhook touched these topics: refetch the queries that registered them. */
  notify(topics: string[]) {
    return this.run(
      this.locked(
        Effect.gen({ self: this }, function* () {
          const ev = yield* this.current;
          const hit = ev.queries.filter((q) => q.args != null && topicsFor(q.tool, q.args).some((t) => topics.includes(t)));
          if (hit.length) yield* this.reconcile(new Set(hit.map((q) => q.name)));
          return hit.map((q) => q.name);
        }),
      ),
    );
  }

  refresh() {
    return this.run(
      this.locked(
        Effect.gen({ self: this }, function* () {
          const ev = yield* this.current;
          yield* this.reconcile(new Set(ev.queries.map((q) => q.name)));
        }),
      ),
    );
  }

  setState(key: string, value: unknown) {
    return this.run(
      this.locked(
        Effect.gen({ self: this }, function* () {
          const stored = (yield* this.get<Record<string, unknown>>("state")) ?? {};
          stored[key] = value;
          yield* this.put("state", stored);
          this.push({ type: "state", key, value });
          yield* this.reconcile();
        }),
      ),
    );
  }

  runAction(name: string, input: any, opts: { confirmed?: boolean } = {}) {
    return this.run(
      Effect.gen({ self: this }, function* () {
        const { result, topics, blockId } = yield* this.locked(
          Effect.gen({ self: this }, function* () {
            const rec = yield* this.record;
            const ev = yield* this.current;
            const action = ev.actions.find((a) => a.name === name);
            if (!action) return yield* Effect.fail(new Refused({ message: `no action ${name}` }));
            if (action.permission === "confirm" && !opts.confirmed) return yield* Effect.fail(new Refused({ message: `${name} needs confirmation` }));
            // Writes aren't retried: a retry could apply them twice.
            const out = yield* callTool({ blockId: rec.id, principal: rec.principal }, action.tool, input, { retries: 0 });
            // Single flight: refetch what this action invalidates before replying.
            yield* this.reconcile(new Set(action.invalidates));
            return { ...out, blockId: rec.id };
          }),
        );
        // Other blocks hear about it the way they'd hear a webhook, after we reply.
        this.ctx.waitUntil(this.rt.runPromise(fanout(topics, blockId)));
        return result;
      }),
    );
  }

  /** What an agent reads: the describe line plus an outline of where each value came from. */
  describeBlock() {
    return this.run(
      Effect.gen({ self: this }, function* () {
        const rec = yield* this.record;
        const v = yield* this.version;
        const ev = yield* this.current;
        const values = yield* this.values;
        return {
          id: rec.id,
          module: v.manifest.id,
          version: v.id,
          commit: v.commit,
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
            freshness: q.refreshMs
              ? `polled every ${q.refreshMs / 1000}s while observed`
              : topicsFor(q.tool, q.args).length
                ? `live via ${topicsFor(q.tool, q.args).join(", ")}`
                : "fetched on change",
            error: values[q.name]?.error,
          })),
          actions: ev.actions,
          state: yield* this.state(ev),
          viewers: this.ctx.getWebSockets().length,
          offset: this.offset,
          sandbox: yield* (yield* Isolates).probe(v.compiled.server),
        };
      }),
    );
  }

  // ---- viewers ---------------------------------------------------------------

  async fetch(req: Request) {
    if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    // A closed or never-created block has no record: refuse before accepting the socket.
    const rec = await this.ctx.storage.get<BlockRecord>("record");
    if (!rec) return new Response("no such block", { status: 404 });
    const since = Number(new URL(req.url).searchParams.get("since") ?? NaN);
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    // Resume from an offset if the log still has it; otherwise start from a snapshot.
    const first = this.log[0]?.offset;
    if (Number.isFinite(since) && first != null && since >= first - 1 && since <= this.offset) {
      for (const entry of this.log) if (entry.offset > since) server.send(JSON.stringify(entry));
    } else {
      server.send(JSON.stringify(await this.run(this.locked(this.snapshot))));
    }
    await this.run(this.scheduleAlarm); // a viewer arrived: polling resumes
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
