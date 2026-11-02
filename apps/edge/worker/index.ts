// Router for the prototype. Real deployments would split these across the
// ingress Worker, the git remote, the sandbox origin and the app.
import FRAME_SDK from "./generated/frame-sdk.js";
import { CompileError } from "./compile";
import type { CanvasOp, CanvasSnapshot } from "./canvas-do";
import { blockStub, canvas, gateway, registry, type Env } from "./env";
import { fanout, makeRuntime, runForCaller } from "./runtime";
import { handleGit, publishCommit } from "./git";
import { frameShell, hostPage } from "./pages";
import { repo } from "./repo";

export { BlockDO } from "./block-do";
export { CanvasDO } from "./canvas-do";
export { GatewayDO } from "./gateway-do";
export { RegistryDO } from "./registry-do";

const WORKSPACE = "workspace";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const js = (body: string) =>
  new Response(body, { headers: { "content-type": "text/javascript; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "no-store" } });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const parts = path.split("/").filter(Boolean);
    try {
      // The git remote agents clone and push: /git/<workspace>.git/...
      if (parts[0] === "git" && parts[1]?.endsWith(".git")) {
        const name = parts[1].slice(0, -4);
        if (name !== WORKSPACE) return new Response("no such repo\n", { status: 404 });
        return handleGit(req, env, name, parts.slice(2).join("/"));
      }

      if (req.method === "GET" && path === "/") {
        return new Response(hostPage(env), { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      if (req.method === "GET" && path === "/frame") {
        const hex = url.searchParams.get("h") ?? "";
        const sri = url.searchParams.get("i") ?? "";
        if (!/^[0-9a-f]{64}$/.test(hex) || !/^sha256-[A-Za-z0-9+/=]+$/.test(sri)) return new Response("bad bundle", { status: 400 });
        return frameShell(url.origin, hex, sri, crypto.randomUUID().replaceAll("-", ""));
      }
      if (req.method === "GET" && path === "/runtime/sdk.js") return js(FRAME_SDK);
      if (req.method === "GET" && parts[0] === "bundles" && parts[1] === "client" && parts.length === 3) {
        const obj = await env.BUNDLES.get(`bundles/client/${parts[2]}`);
        return obj ? js(await obj.text()) : new Response("not found", { status: 404 });
      }

      // Publish every module at the repo's head. On an empty canvas, also open the
      // blocks listed in the repo's canvas.json, if any: a one-time template, not a sync.
      if (req.method === "POST" && path === "/api/seed") {
        const r = repo(env, WORKSPACE);
        const head = await r.head();
        if (!head) return json({ error: "repo has no commits; is the git stand-in running?" }, 503);
        const lines = await publishCommit(env, WORKSPACE, null, head);
        const c = canvas(env);
        if (!(await c.list()).length) {
          const template = JSON.parse((await r.readFile(head, "canvas.json")) ?? "[]") as { id: string; module: string; props?: Record<string, unknown> }[];
          for (const t of template) {
            await c.apply({ type: "open", id: t.id, module: t.module, props: t.props });
            lines.push(`canvas: opened ${t.id} from template`);
          }
        }
        return json({ head, lines });
      }

      // The canvas: which blocks exist and where. Changed only by ops.
      if (path === "/api/canvas" && req.method === "GET") return json(await canvas(env).snapshot());
      if (path === "/api/canvas/ws") return canvas(env).fetch(req);
      if (path === "/api/canvas/ops" && req.method === "POST") {
        const op = await req.json<CanvasOp>();
        try {
          return json(await canvas(env).apply(op, req.headers.get("x-actor") ?? "user:byron"));
        } catch (e: any) {
          return json({ error: e.message }, 400);
        }
      }
      if (path === "/api/modules" && req.method === "GET") return json(await registry(env).listModules());
      // Compatibility view of the canvas for scripts: one row per block.
      if (path === "/api/blocks" && req.method === "GET") {
        // RPC result types for nested records instantiate too deeply for tsc; the shape is CanvasSnapshot.
        const snap = (await canvas(env).snapshot()) as unknown as CanvasSnapshot;
        return json(snap.blocks.map((b) => ({ id: b.id, module: b.module, version: b.versionId, props: b.props, rect: b.rect, client: b.client })));
      }
      if (parts[0] === "api" && parts[1] === "blocks" && parts[2]) {
        const stub = blockStub(env, parts[2]);
        if (parts[3] === "ws") return stub.fetch(req);
        if (req.method === "GET" && parts.length === 3) return json(await stub.describeBlock());
        if (req.method === "POST" && parts[3] === "refresh") {
          await stub.refresh();
          return json({ ok: true });
        }
        if (req.method === "POST" && parts[3] === "actions" && parts[4]) {
          const { input, confirmed } = await req.json<any>();
          return json({ result: await stub.runAction(parts[4], input, { confirmed }) });
        }
        if (req.method === "POST" && parts[3] === "state") {
          const { key, value } = await req.json<any>();
          await stub.setState(key, value);
          return json({ ok: true });
        }
      }

      // Ingress: a GitHub delivery. Here the payload is a simulated upstream change.
      if (req.method === "POST" && path === "/webhook/github") {
        const change = await req.json<any>();
        const { pr, topics } = await gateway(env).simulateUpstream(change);
        const woke = await runForCaller(makeRuntime(env), fanout(topics));
        return json({ pr, topics, woke });
      }
      return new Response("not found", { status: 404 });
    } catch (e: any) {
      return json({ error: e.message }, e instanceof CompileError ? 422 : 500);
    }
  },
};
