// Router for the prototype. Real deployments would split these across the
// ingress Worker, the compile service, the sandbox origin and the app.
import FRAME_SDK from "./generated/frame-sdk.js";
import ESCAPE from "../examples/escape.tsx";
import ONCALL from "../examples/oncall.tsx";
import { compile, CompileError } from "./compile";
import { blockStub, fanout, gateway, registry, type Env } from "./env";
import { loadIsolate } from "./isolate";
import { frameShell, hostPage } from "./pages";
import type { ModuleVersion } from "./registry-do";

export { BlockDO } from "./block-do";
export { GatewayDO } from "./gateway-do";
export { RegistryDO } from "./registry-do";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const js = (body: string) =>
  new Response(body, { headers: { "content-type": "text/javascript; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "no-store" } });

/** Compile a module, read its manifest by evaluating it in the sandbox, and record the version. */
async function publishModule(env: Env, moduleId: string, source: string) {
  const compiled = await compile(source, env.BUNDLES);
  const ev = await loadIsolate(env, compiled.server).evaluate({ props: {}, state: {}, values: {} });
  if (!ev.id) throw new CompileError("the module must `export default Block.define({ id, tools, setup, view })`");
  const version: ModuleVersion = {
    id: `${moduleId}@${compiled.server.hex.slice(0, 12)}`,
    moduleId,
    compiled,
    manifest: { id: ev.id, tools: ev.tools, queries: ev.queries.map((q: any) => q.name), actions: ev.actions.map((a: any) => a.name) },
    createdAt: Date.now(),
  };
  await registry(env).putVersion(version);
  return version;
}

async function createBlock(env: Env, id: string, versionId: string, props: Record<string, unknown>, principal = "user:byron") {
  await registry(env).putBlock({ id, versionId, props, principal });
  return blockStub(env, id).init({ id, versionId, props, principal });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const parts = path.split("/").filter(Boolean);
    try {
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

      if (req.method === "POST" && path === "/api/seed") {
        const oncall = await publishModule(env, "oncall-desk", ONCALL);
        const escape = await publishModule(env, "escape-attempts", ESCAPE);
        const created = {
          "web-desk": await createBlock(env, "web-desk", oncall.id, { repo: "inspect/web" }),
          "api-desk": await createBlock(env, "api-desk", oncall.id, { repo: "inspect/api" }),
          "escape": await createBlock(env, "escape", escape.id, {}),
        };
        return json({ versions: [oncall.id, escape.id], blocks: created });
      }
      if (req.method === "POST" && path === "/api/modules") {
        const { moduleId, source } = await req.json<{ moduleId: string; source: string }>();
        return json(await publishModule(env, moduleId, source));
      }
      if (path === "/api/blocks" && req.method === "GET") {
        const reg = registry(env);
        const blocks = await reg.listBlocks();
        return json(
          await Promise.all(
            blocks.map(async (b) => {
              const v = (await reg.getVersion(b.versionId))!;
              return { id: b.id, module: v.manifest.id, props: b.props, client: { hex: v.compiled.client.hex, sri: v.compiled.client.sri } };
            }),
          ),
        );
      }
      if (path === "/api/blocks" && req.method === "POST") {
        const { id, versionId, props, principal } = await req.json<any>();
        return json({ describe: await createBlock(env, id, versionId, props ?? {}, principal) });
      }
      if (parts[0] === "api" && parts[1] === "blocks" && parts[2]) {
        const stub = blockStub(env, parts[2]);
        if (parts[3] === "ws") return stub.fetch(req);
        if (req.method === "GET" && parts.length === 3) return json(await stub.describeBlock());
        if (req.method === "POST" && parts[3] === "refresh") return json(await stub.refresh());
        if (req.method === "POST" && parts[3] === "actions" && parts[4]) {
          const { input, confirmed } = await req.json<any>();
          return json({ result: await stub.runAction(parts[4], input, { confirmed }) });
        }
        if (req.method === "POST" && parts[3] === "state") {
          const { key, value } = await req.json<any>();
          return json(await stub.setState(key, value));
        }
      }

      // Ingress: a GitHub delivery. Here the payload is a simulated upstream change.
      if (req.method === "POST" && path === "/webhook/github") {
        const change = await req.json<any>();
        const { pr, topics } = await gateway(env).simulateUpstream(change);
        const woke = await fanout(env, topics);
        return json({ pr, topics, woke });
      }
      return new Response("not found", { status: 404 });
    } catch (e: any) {
      return json({ error: e.message }, e instanceof CompileError ? 422 : 500);
    }
  },
};
