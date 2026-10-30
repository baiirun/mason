// Composes an agent's context from the blocks around it, and the tools it can call on them.
//
// Scope: the agent's link group if it has one, otherwise its whole space. Hidden blocks
// are left out. Each block is described by where it sits relative to the agent, so
// "the doc next to me" means something.
import { blocksIn, findStack, layoutRects, relativePosition, uid, type BlockRecord, type Edge, type Workspace } from "@mason/core";
import { defOf, serverBlocks, type Permission } from "../blocks";
import { submit, sync } from "../workspace";

export interface ScopedBlock {
  block: BlockRecord;
  title: string;
  summary: string;
  position: string;
  tools: string[];
}

/** Find the block an agent lives in: block id, id prefix, "session:<sessionId>", or kind. */
export function resolveBlock(ws: Workspace, target: string): BlockRecord | undefined {
  const all = Object.values(ws.blocks);
  if (target.startsWith("session:")) {
    const sid = target.slice(8);
    return all.find((b) => b.kind === "inspect.session" && b.state.sessionId === sid);
  }
  return ws.blocks[target] ?? all.find((b) => b.id.startsWith(target)) ?? all.find((b) => b.kind === target);
}

export function scope(ws: Workspace, agentId: string) {
  const agent = ws.blocks[agentId];
  const space = ws.spaces.find((s) => findStack(s.root, agentId));
  if (!agent || !space) throw new Error(`agent block ${agentId} is not in the layout`);
  const rects = layoutRects(space.root);
  const agentStack = findStack(space.root, agentId)!;
  const blocks: ScopedBlock[] = [];
  for (const id of blocksIn(space.root)) {
    const b = ws.blocks[id];
    if (!b || id === agentId || b.hidden) continue;
    if (agent.link && b.link !== agent.link) continue;
    const def = defOf(b.kind);
    if (!def) continue;
    const stack = findStack(space.root, id)!;
    const position =
      stack.id === agentStack.id
        ? "a tab next to you"
        : `${relativePosition(rects[agentStack.id]!, rects[stack.id]!)} you${stack.active === id ? "" : " (background tab)"}`;
    const { title, summary } = def.describe(b, ws);
    blocks.push({ block: b, title, summary, position, tools: (def.tools ?? []).map((t) => t.name) });
  }
  return { agent, space, blocks };
}

/** The short text an agent gets at the start of every turn. Full content comes from read_block. */
export function manifest(ws: Workspace, agentId: string): string {
  const { agent, space, blocks } = scope(ws, agentId);
  const me = defOf(agent.kind)?.describe(agent, ws).title ?? agent.kind;
  const scopeNote = agent.link ? `link group ${agent.link}` : `space “${space.name}”`;
  const lines = [
    `You are ${me} [${agent.id}], in ${scopeNote}.`,
    blocks.length ? `Blocks around you (${blocks.length}):` : "There are no other blocks around you.",
    ...blocks.map(
      (b) => `- [${b.block.id}] ${b.title}, ${b.position}. ${b.summary.replace(/\.?$/, ".")}${b.tools.length ? ` Tools: ${b.tools.join(", ")}.` : ""}`,
    ),
    "Call read_block(blockId) for a block's full content.",
  ];
  return lines.join("\n");
}

export interface AgentTool {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  permission: Permission;
}

const PLACEMENTS: Edge[] = ["left", "right", "up", "down"];

/** Tool list for one agent: layout tools, plus kind tools for kinds present in its scope. */
export function toolsFor(ws: Workspace, agentId: string): AgentTool[] {
  const { blocks } = scope(ws, agentId);
  const ids = blocks.map((b) => b.block.id);
  const tools: AgentTool[] = [
    {
      name: "list_blocks",
      description: "Describe the blocks around you: what each is, where it sits, and its tools.",
      inputSchema: { type: "object", properties: {} },
      permission: "read",
    },
    {
      name: "read_block",
      description: "Read the full content of a block around you.",
      inputSchema: { type: "object", properties: { blockId: { type: "string", enum: ids } }, required: ["blockId"] },
      permission: "read",
    },
    {
      name: "open_block",
      description: "Open a new block beside yourself (or beside another block): a split on one side, or a tab.",
      inputSchema: {
        type: "object",
        properties: {
          kind: { type: "string", enum: serverBlocks.map((d) => d.kind) },
          state: { type: "object", description: "Block state, e.g. {\"sessionId\": \"s-auth\"} or {\"docId\": \"notes\"}" },
          placement: { type: "string", enum: [...PLACEMENTS, "tab"], default: "right" },
          relativeTo: { type: "string", description: "Block id to place it next to. Defaults to you." },
        },
        required: ["kind"],
      },
      permission: "write",
    },
    {
      name: "close_block",
      description: "Close a block around you.",
      inputSchema: { type: "object", properties: { blockId: { type: "string", enum: ids } }, required: ["blockId"] },
      permission: "confirm",
    },
  ];
  const kinds = new Set(blocks.map((b) => b.block.kind));
  for (const kind of kinds) {
    const kindIds = blocks.filter((b) => b.block.kind === kind).map((b) => b.block.id);
    for (const t of defOf(kind)?.tools ?? []) {
      tools.push({
        name: t.name,
        description: `${t.description} (${kind})`,
        inputSchema: {
          type: "object",
          properties: { blockId: { type: "string", enum: kindIds }, ...(t.properties ?? {}) },
          required: ["blockId", ...(t.required ?? [])],
        },
        permission: t.permission,
      });
    }
  }
  return tools;
}

/** Call a tool as the agent in `agentId`. Agents can only touch blocks in their scope. */
export async function callTool(agentId: string, name: string, args: Record<string, any>, actor = `agent:${agentId}`): Promise<string> {
  const ws = sync.state;
  const { blocks, space } = scope(ws, agentId);
  const inScope = (id: string) => {
    const b = blocks.find((x) => x.block.id === id);
    if (!b) throw new Error(`block ${id} is not around you`);
    return b.block;
  };
  switch (name) {
    case "list_blocks":
      return manifest(ws, agentId);
    case "read_block": {
      const b = inScope(args.blockId);
      return defOf(b.kind)?.read?.(b, ws) ?? "(this block has no readable content)";
    }
    case "open_block": {
      const target = args.relativeTo ? inScope(args.relativeTo).id : agentId;
      const placement = (args.placement ?? "right") as Edge | "tab";
      const block = { id: uid("block-"), kind: args.kind, state: args.state ?? {}, link: ws.blocks[agentId]?.link ?? null };
      const at =
        placement === "tab"
          ? ({ mode: "tab", target } as const)
          : ({ mode: "split", target, edge: placement, stackId: uid("stack-"), splitId: uid("split-") } as const);
      const res = submit(actor, { type: "openBlock", spaceId: space.id, block, at });
      return res.type === "op" ? `opened ${block.id}` : `rejected: ${res.reason}`;
    }
    case "close_block": {
      const res = submit(actor, { type: "closeBlock", blockId: inScope(args.blockId).id });
      return res.type === "op" ? "closed" : `rejected: ${res.reason}`;
    }
  }
  const b = inScope(args.blockId);
  const tool = defOf(b.kind)?.tools?.find((t) => t.name === name);
  if (!tool) throw new Error(`${b.kind} has no tool ${name}`);
  const out = await tool.run({ block: b, ws, actor }, args);
  return typeof out === "string" ? out : JSON.stringify(out);
}

/** For the UI: which session blocks are which agents. */
export const agentBlockForSession = (sessionId: string) =>
  Object.values(sync.state.blocks).find((b) => b.kind === "inspect.session" && b.state.sessionId === sessionId)?.id;

