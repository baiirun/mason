// The git remote agents use. It forwards smart-HTTP git to the repo host (the
// local stand-in, or Artifacts) and, when a push moves main, publishes what
// changed: block modules are compiled and the blocks using them switch to the
// new version in place (via the canvas, which owns which blocks exist). The
// result comes back in the push output as `remote: mason: ...` lines.
import { Data, Effect } from "effect";
import { compile } from "./compile";
import type { Env } from "./env";
import type { ModuleVersion } from "./registry-do";
import { repo, type Repo } from "./repo";
import { Isolates, makeRuntime, Peers, Registry, runForCaller } from "./runtime";

const MODULE_PATH = /^blocks\/([a-z0-9-]+)\.tsx$/;

function authorized(req: Request, env: Env) {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Basic ")) return false;
  const [, password] = atob(auth.slice(6)).split(":");
  return password === env.GIT_TOKEN;
}

export async function handleGit(req: Request, env: Env, repoName: string, rest: string) {
  if (!authorized(req, env)) {
    return new Response("authentication required\n", { status: 401, headers: { "www-authenticate": 'Basic realm="mason"' } });
  }
  const url = new URL(req.url);
  const isPush = rest === "git-receive-pack";
  const r = repo(env, repoName);
  const before = isPush ? await r.head() : null;

  const headers = new Headers();
  for (const h of ["content-type", "content-encoding", "accept", "git-protocol"]) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }
  const upstream = await fetch(`${env.GIT_UPSTREAM}/git/${repoName}.git/${rest}${url.search}`, {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
  });
  if (!isPush) return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });

  // A push: let it finish, see whether main moved, publish, and report back in the push output.
  const body = new Uint8Array(await upstream.arrayBuffer());
  const after = await r.head();
  const lines = after && after !== before ? await publishCommit(env, repoName, before, after) : [];
  return new Response(appendRemoteMessages(body, lines), { status: upstream.status, headers: upstream.headers });
}

/** Why a module wasn't published; becomes a `not published:` line. */
class PublishError extends Data.TaggedError("PublishError")<{ message: string }> {}

/** Publish every module a commit range changed. Returns human-readable lines. */
export function publishCommit(env: Env, repoName: string, from: string | null, to: string) {
  return runForCaller(makeRuntime(env), publishCommitEffect(env, repoName, from, to));
}

const publishCommitEffect = (env: Env, repoName: string, from: string | null, to: string) =>
  Effect.gen(function* () {
    const r = repo(env, repoName);
    const changed = yield* Effect.tryPromise({ try: () => r.changed(from, to), catch: (e: any) => new PublishError({ message: String(e?.message ?? e) }) });
    const lines: string[] = [];
    for (const path of changed) {
      const m = MODULE_PATH.exec(path);
      if (!m) continue;
      // Each module succeeds or fails on its own; one bad file doesn't stop the rest.
      const line = yield* publishPath(env, r, m[1]!, path, to).pipe(
        Effect.catch((e) => Effect.succeed(`${path} not published: ${e.message} (blocks stay on their previous version)`)),
      );
      lines.push(line);
    }
    return lines;
  });

const publishPath = (env: Env, r: Repo, moduleId: string, path: string, commit: string) =>
  Effect.gen(function* () {
    const source = yield* Effect.promise(() => r.readFile(commit, path));
    if (source == null) return `${path} deleted; blocks using ${moduleId} keep their last version`;
    const version = yield* publishModule(env, moduleId, source, commit);
    // Which blocks exist is the canvas's business; it moves the ones following head.
    const { moved, pinned } = yield* (yield* Peers).moduleUpdated(moduleId, version.id);
    const pinnedNote = pinned.length ? `; pinned, not moved: ${pinned.join(", ")}` : "";
    return `${path} → ${version.id}; reloaded ${moved.join(", ") || "no blocks"}${pinnedNote}`;
  });

const publishModule = (env: Env, moduleId: string, source: string, commit: string) =>
  Effect.gen(function* () {
    const compiled = yield* Effect.tryPromise({
      try: () => compile(source, env.BUNDLES),
      catch: (e: any) => new PublishError({ message: String(e?.message ?? e) }),
    });
    const ev = yield* (yield* Isolates).evaluate(compiled.server, { props: {}, state: {}, values: {} });
    if (!ev.id) return yield* Effect.fail(new PublishError({ message: "the module must `export default Block.define({ id, setup, view })`" }));
    const version: ModuleVersion = {
      id: `${moduleId}@${commit.slice(0, 7)}`,
      moduleId,
      commit,
      compiled,
      manifest: { id: ev.id, queries: ev.queries.map((q: any) => q.name), actions: ev.actions.map((a: any) => a.name) },
      createdAt: Date.now(),
    };
    const reg = yield* Registry;
    yield* reg.putVersion(version);
    yield* reg.setHead(moduleId, version.id);
    return version;
  });

/**
 * Add `remote:` lines to a receive-pack response. With side-band, band 2 is
 * progress text the git client prints; insert our packets before the final flush.
 */
function appendRemoteMessages(body: Uint8Array, lines: string[]) {
  const flush = new TextEncoder().encode("0000");
  const endsWithFlush = body.length >= 4 && body.subarray(body.length - 4).every((b, i) => b === flush[i]);
  if (!lines.length || !endsWithFlush) return body;
  const enc = new TextEncoder();
  const packets = lines.map((line) => {
    const payload = enc.encode(`mason: ${line}\n`);
    const len = (payload.length + 5).toString(16).padStart(4, "0");
    return new Uint8Array([...enc.encode(len), 2, ...payload]);
  });
  const total = body.length + packets.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  out.set(body.subarray(0, body.length - 4), 0);
  let o = body.length - 4;
  for (const p of packets) {
    out.set(p, o);
    o += p.length;
  }
  out.set(flush, o);
  return out;
}
