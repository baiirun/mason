// The Effect runtime the Durable Objects and publish path run on: typed errors,
// services for everything outside a DO (gateway, registry, isolates, other
// blocks), and the policies we apply to them (retries, timeouts).
import { Context, Data, Duration, Effect, Layer, ManagedRuntime, Result, Schedule } from "effect";
import type { Bundle } from "./compile";
import { blockStub, canvas, gateway, registry, type Env } from "./env";
import type { Grant } from "./gateway-do";
import { loadIsolate } from "./isolate";
import type { BlockRecord, ModuleVersion } from "./registry-do";

// ---- errors ---------------------------------------------------------------------

/** A tool call failed. `retryable` is false for errors retrying can't fix (unknown tool, bad args). */
export class ToolError extends Data.TaggedError("ToolError")<{ tool: string; message: string; retryable: boolean }> {}
export class BundleError extends Data.TaggedError("BundleError")<{ key: string; message: string }> {}
export class NotFound extends Data.TaggedError("NotFound")<{ message: string }> {}
/** A caller-facing refusal: bad op, unknown action, missing confirmation. */
export class Refused extends Data.TaggedError("Refused")<{ message: string }> {}
/** A call to another Durable Object (a block or the canvas) failed. */
export class PeerError extends Data.TaggedError("PeerError")<{ message: string }> {}

// ---- services -------------------------------------------------------------------

export class Gateway extends Context.Service<
  Gateway,
  { call(grant: Grant, tool: string, args: unknown): Effect.Effect<{ result: unknown; topics: string[] }, ToolError> }
>()("mason/Gateway") {}

export class Registry extends Context.Service<
  Registry,
  {
    getVersion(id: string): Effect.Effect<ModuleVersion, NotFound>;
    getHead(module: string): Effect.Effect<string | null>;
    putVersion(v: ModuleVersion): Effect.Effect<void>;
    setHead(module: string, versionId: string): Effect.Effect<void>;
    setSubscriptions(blockId: string, topics: string[]): Effect.Effect<void>;
    lookup(topics: string[]): Effect.Effect<string[]>;
  }
>()("mason/Registry") {}

export class Isolates extends Context.Service<
  Isolates,
  {
    evaluate(bundle: Bundle, snapshot: unknown): Effect.Effect<any, BundleError>;
    probe(bundle: Bundle): Effect.Effect<{ envKeys: string[]; fetch: string }, BundleError>;
  }
>()("mason/Isolates") {}

/** Other Block DOs and the canvas, for fan-out and version moves. */
export class Peers extends Context.Service<
  Peers,
  {
    notify(blockId: string, topics: string[]): Effect.Effect<void, PeerError>;
    init(rec: BlockRecord): Effect.Effect<string | null, PeerError>;
    update(rec: BlockRecord): Effect.Effect<string | null, PeerError>;
    destroy(blockId: string): Effect.Effect<void, PeerError>;
    moduleUpdated(module: string, versionId: string): Effect.Effect<{ moved: string[]; pinned: string[] }, PeerError>;
  }
>()("mason/Peers") {}

// ---- live implementations ---------------------------------------------------------

/** Errors that come back from the gateway and won't change on retry. */
const PERMANENT = /^(unknown tool|no PR|.* is not allowed)/;

/** An RPC to the registry. Its failures are bugs or platform faults, so they're defects, not typed errors. */
const rpc = <A>(f: () => Promise<A>) => Effect.promise(f);
/** An RPC to a block or the canvas. Their errors carry a message meant for the caller (e.g. a block that can't init). */
const peer = <A>(f: () => Promise<A>) => Effect.tryPromise({ try: f, catch: (e: any) => new PeerError({ message: String(e?.message ?? e) }) });

export const live = (env: Env) =>
  Layer.mergeAll(
    Layer.succeed(Gateway, {
      call: (grant, tool, args) =>
        Effect.tryPromise({
          try: () => gateway(env).call(grant, tool, args),
          catch: (e: any) => new ToolError({ tool, message: String(e?.message ?? e), retryable: !PERMANENT.test(String(e?.message ?? e)) }),
        }),
    }),
    Layer.succeed(Registry, {
      getVersion: (id) =>
        rpc(() => registry(env).getVersion(id)).pipe(
          Effect.flatMap((v) => (v ? Effect.succeed(v as ModuleVersion) : Effect.fail(new NotFound({ message: `version ${id} not found` })))),
        ),
      getHead: (module) => rpc(() => registry(env).getHead(module)),
      putVersion: (v) => rpc(() => registry(env).putVersion(v)),
      setHead: (module, versionId) => rpc(() => registry(env).setHead(module, versionId)),
      setSubscriptions: (blockId, topics) => rpc(() => registry(env).setSubscriptions(blockId, topics)),
      lookup: (topics) => rpc(() => registry(env).lookup(topics)),
    }),
    Layer.succeed(Isolates, {
      evaluate: (bundle, snapshot) =>
        Effect.tryPromise({
          try: () => loadIsolate(env, bundle).evaluate(snapshot),
          catch: (e: any) => new BundleError({ key: bundle.key, message: String(e?.message ?? e) }),
        }),
      probe: (bundle) =>
        Effect.tryPromise({
          try: () => loadIsolate(env, bundle).probe(),
          catch: (e: any) => new BundleError({ key: bundle.key, message: String(e?.message ?? e) }),
        }),
    }),
    Layer.succeed(Peers, {
      notify: (blockId, topics) => peer(() => blockStub(env, blockId).notify(topics)).pipe(Effect.asVoid),
      init: (rec) => peer(() => blockStub(env, rec.id).init(rec)),
      update: (rec) => peer(() => blockStub(env, rec.id).update(rec)),
      destroy: (blockId) => peer(() => blockStub(env, blockId).destroy()),
      moduleUpdated: (module, versionId) => peer(() => canvas(env).moduleUpdated(module, versionId)),
    }),
  );

export type Services = Gateway | Registry | Isolates | Peers;

// ---- policies -------------------------------------------------------------------

/**
 * A tool call as the platform makes it: 15 s timeout, and up to `retries` retries
 * with backoff for retryable failures. Reads default to 3; writes pass 0, since a
 * retry could apply them twice.
 */
export const callTool = (grant: Grant, tool: string, args: unknown, { retries = 3 }: { retries?: number } = {}) =>
  Effect.gen(function* () {
    const gw = yield* Gateway;
    return yield* gw.call(grant, tool, args).pipe(
      Effect.timeoutOrElse({
        duration: Duration.seconds(15),
        orElse: () => Effect.fail(new ToolError({ tool, message: "timed out after 15s", retryable: true })),
      }),
      Effect.retry({ schedule: Schedule.exponential("100 millis"), times: retries, while: (e) => e.retryable }),
      Effect.tapError((e) => Effect.logWarning(`tool ${tool} failed: ${e.message}`)),
    );
  });

/** Webhook-style fan-out: topic index lookup, then wake each subscribed block except `except`. */
export const fanout = (topics: string[], except?: string) =>
  Effect.gen(function* () {
    if (!topics.length) return [];
    const ids = (yield* (yield* Registry).lookup(topics)).filter((id) => id !== except);
    const peers = yield* Peers;
    // One block failing to refresh shouldn't stop the others hearing about it.
    yield* Effect.forEach(ids, (id) => peers.notify(id, topics).pipe(Effect.catchTag("PeerError", (e) => Effect.logWarning(`notify ${id}: ${e.message}`))), {
      concurrency: "unbounded",
      discard: true,
    });
    return ids;
  });

// ---- running at the edges ---------------------------------------------------------

export type Runtime = ManagedRuntime.ManagedRuntime<Services, never>;
export const makeRuntime = (env: Env): Runtime => ManagedRuntime.make(live(env));

/**
 * Run an effect for an RPC or socket caller. Typed failures become a plain Error
 * carrying the failure's message, which survives the trip over RPC.
 */
export const runForCaller = <A, E extends { message: string }>(rt: Runtime, eff: Effect.Effect<A, E, Services>): Promise<A> =>
  rt.runPromise(Effect.result(eff)).then((r) => (Result.isSuccess(r) ? r.success : Promise.reject(new Error(r.failure.message))));
