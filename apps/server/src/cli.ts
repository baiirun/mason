// Drive a running mason server from the terminal, the way an agent would.
//   npm run mux -- ls
//   npm run mux -- open inspect.preview --right-of inspect.session --link A
//   npm run mux -- open inspect.session --state '{"sessionId":"s-docs"}' --tab-in <block>
//   npm run mux -- close <block>
//   npm run mux -- space "Scratch"
//   npm run mux -- context session:s-docs          what the agent in that block sees
//   npm run mux -- call session:s-docs doc_append '{"blockId":"block-…","text":"hi"}'
import { blocksIn, findStack, uid, type Op, type Workspace } from "@mason/core";

const BASE = process.env.MASON_URL ?? "http://localhost:4317";
const [cmd, ...rest] = process.argv.slice(2);

function flags(args: string[]) {
  const pos: string[] = [];
  const f: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) f[a.slice(2)] = args[++i] ?? "";
    else pos.push(a);
  }
  return { pos, f };
}

async function state(): Promise<Workspace> {
  return (await (await fetch(`${BASE}/api/state`)).json()).state;
}
async function send(ops: Op[]) {
  const res = await fetch(`${BASE}/api/ops`, { method: "POST", body: JSON.stringify({ ops, clientId: "cli" }) });
  const out = await res.json();
  for (const r of out.results) console.log(r.type === "op" ? `ok v${r.version} ${r.op.type}` : `rejected: ${r.reason}`);
}

/** Rex-style target resolution: exact id, then id prefix, then first block of that kind. */
function resolve(ws: Workspace, target: string) {
  const all = Object.values(ws.blocks);
  const hit = ws.blocks[target] ?? all.find((b) => b.id.startsWith(target)) ?? all.find((b) => b.kind === target);
  if (!hit) throw new Error(`no block matches "${target}"`);
  const space = ws.spaces.find((s) => findStack(s.root, hit.id))!;
  return { block: hit, space };
}

const ws = await state();
const { pos, f } = flags(rest);
switch (cmd) {
  case "ls":
    for (const s of ws.spaces) {
      console.log(`${s.name}  (${s.id})`);
      for (const id of blocksIn(s.root)) {
        const b = ws.blocks[id]!;
        console.log(`  ${b.id}  ${b.kind}  ${JSON.stringify(b.state)}${b.link ? `  link:${b.link}` : ""}`);
      }
    }
    break;
  case "open": {
    const kind = pos[0];
    if (!kind) throw new Error("usage: open <kind> [--right-of|--left-of|--above|--below|--tab-in <block>] [--state json] [--link A]");
    const edges = { "right-of": "right", "left-of": "left", above: "up", below: "down" } as const;
    const block = { id: uid("block-"), kind, state: JSON.parse(f.state ?? "{}"), link: f.link ?? null };
    const edgeFlag = (Object.keys(edges) as (keyof typeof edges)[]).find((k) => f[k]);
    let op: Op;
    if (f["tab-in"]) {
      const t = resolve(ws, f["tab-in"]);
      op = { type: "openBlock", spaceId: t.space.id, block, at: { mode: "tab", target: t.block.id } };
    } else if (edgeFlag) {
      const t = resolve(ws, f[edgeFlag]!);
      op = { type: "openBlock", spaceId: t.space.id, block, at: { mode: "split", target: t.block.id, edge: edges[edgeFlag], stackId: uid("stack-"), splitId: uid("split-") } };
    } else {
      const space = ws.spaces.find((s) => s.name === f.space || s.id === f.space) ?? ws.spaces[0]!;
      op = { type: "openBlock", spaceId: space.id, block, at: { mode: "split", target: "root", edge: "right", stackId: uid("stack-"), splitId: uid("split-") } };
    }
    await send([op]);
    break;
  }
  case "close":
    await send([{ type: "closeBlock", blockId: resolve(ws, pos[0] ?? "").block.id }]);
    break;
  case "space":
    await send([{ type: "addSpace", spaceId: uid("space-"), name: pos[0] ?? "New space" }]);
    break;
  case "context": {
    const out = await (await fetch(`${BASE}/api/agent/context?block=${encodeURIComponent(pos[0] ?? "inspect.session")}`)).json();
    console.log(out.manifest ?? out.error);
    if (out.tools) console.log(`\nTools: ${out.tools.map((t: { name: string; permission: string }) => `${t.name} (${t.permission})`).join(", ")}`);
    break;
  }
  case "call": {
    const [block, name, args] = pos;
    const res = await fetch(`${BASE}/api/agent/call`, { method: "POST", body: JSON.stringify({ block, name, args: JSON.parse(args ?? "{}") }) });
    const out = await res.json();
    console.log(out.result ?? out.error);
    break;
  }
  case "reset":
    await fetch(`${BASE}/api/reset`, { method: "POST" });
    console.log("reset to seed layout");
    break;
  default:
    console.log("commands: ls | open <kind> [...] | close <block> | space <name> | context <block> | call <block> <tool> <json> | reset");
}
