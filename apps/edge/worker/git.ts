// The git remote agents use. It forwards smart-HTTP git to the repo host (the
// local stand-in, or Artifacts) and, when a push moves main, publishes what
// changed: block modules are compiled and the blocks using them switch to the
// new version in place (via the canvas, which owns which blocks exist). The
// result comes back in the push output as `remote: mason: ...` lines.
import { compile, CompileError } from "./compile";
import { canvas, registry, type Env } from "./env";
import { loadIsolate } from "./isolate";
import type { ModuleVersion } from "./registry-do";
import { repo } from "./repo";

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

/** Publish every module a commit range changed. Returns human-readable lines. */
export async function publishCommit(env: Env, repoName: string, from: string | null, to: string): Promise<string[]> {
  const r = repo(env, repoName);
  const lines: string[] = [];
  for (const path of await r.changed(from, to)) {
    const m = MODULE_PATH.exec(path);
    if (!m) continue;
    const moduleId = m[1]!;
    const source = await r.readFile(to, path);
    if (source == null) {
      lines.push(`${path} deleted; blocks using ${moduleId} keep their last version`);
      continue;
    }
    try {
      const version = await publishModule(env, moduleId, source, to);
      // Which blocks exist is the canvas's business; it moves the ones following head.
      const { moved, pinned } = await canvas(env).moduleUpdated(moduleId, version.id);
      const pinnedNote = pinned.length ? `; pinned, not moved: ${pinned.join(", ")}` : "";
      lines.push(`${path} → ${version.id}; reloaded ${moved.join(", ") || "no blocks"}${pinnedNote}`);
    } catch (e: any) {
      lines.push(`${path} not published: ${e.message} (blocks stay on their previous version)`);
    }
  }
  return lines;
}

async function publishModule(env: Env, moduleId: string, source: string, commit: string) {
  const compiled = await compile(source, env.BUNDLES);
  const ev = await loadIsolate(env, compiled.server).evaluate({ props: {}, state: {}, values: {} });
  if (!ev.id) throw new CompileError("the module must `export default Block.define({ id, setup, view })`");
  const version: ModuleVersion = {
    id: `${moduleId}@${commit.slice(0, 7)}`,
    moduleId,
    commit,
    compiled,
    manifest: { id: ev.id, queries: ev.queries.map((q: any) => q.name), actions: ev.actions.map((a: any) => a.name) },
    createdAt: Date.now(),
  };
  const reg = registry(env);
  await reg.putVersion(version);
  await reg.setHead(moduleId, version.id);
  return version;
}

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
