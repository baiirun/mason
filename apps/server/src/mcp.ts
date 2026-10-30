// MCP endpoint: lets a real agent (Claude Code, the Agent SDK...) sit "inside" a block.
//
//   claude mcp add --transport http mason "http://localhost:4317/mcp?block=session:s-docs"
//
// `block` is the block the agent lives in (id, id prefix, kind, or session:<id>). Its tool
// list is scoped to the blocks around it and changes as the layout changes
// (notifications/tools/list_changed). The manifest is also exposed as a resource.
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { callTool, manifest, resolveBlock, toolsFor } from "./agent/context";
import { onOp, sync } from "./workspace";

interface Conn {
  server: Server;
  transport: StreamableHTTPServerTransport;
  target: string;
  lastTools: string;
}
const conns = new Map<string, Conn>();

const agentId = (target: string) => {
  const b = resolveBlock(sync.state, target);
  if (!b) throw new Error(`no block matches "${target}"`);
  return b.id;
};

function createServer(target: string) {
  const server = new Server(
    { name: "mason", version: "0.0.0" },
    {
      capabilities: { tools: { listChanged: true }, resources: {} },
      instructions:
        "You live in a block of a mason workspace, next to other blocks (docs, sessions, diffs, previews). " +
        "Read the mason://context resource or call list_blocks to see what's around you, read_block for full content, " +
        "and the kind tools (doc_append, session_send, ...) to act on them. The person sees every change live.",
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolsFor(sync.state, agentId(target)).map(({ name, description, inputSchema, permission }) => ({
      name,
      description,
      inputSchema,
      annotations: { readOnlyHint: permission === "read", destructiveHint: permission === "confirm" },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      const text = await callTool(agentId(target), req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>, `mcp:${target}`);
      return { content: [{ type: "text", text }] };
    } catch (e) {
      return { content: [{ type: "text", text: (e as Error).message }], isError: true };
    }
  });
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{ uri: "mason://context", name: "Blocks around you", mimeType: "text/plain" }],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => ({
    contents: [{ uri: req.params.uri, mimeType: "text/plain", text: manifest(sync.state, agentId(target)) }],
  }));
  return server;
}

// When the layout changes, tell each connected agent if its tool list changed.
onOp(() => {
  for (const c of conns.values()) {
    let sig: string;
    try {
      sig = JSON.stringify(toolsFor(sync.state, agentId(c.target)));
    } catch {
      continue;
    }
    if (sig !== c.lastTools) {
      c.lastTools = sig;
      void c.server.sendToolListChanged().catch(() => {});
    }
  }
});

export async function handleMcp(req: IncomingMessage, res: ServerResponse, body: unknown) {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const existing = sessionId ? conns.get(sessionId) : undefined;
  if (existing) return existing.transport.handleRequest(req, res, body);

  if (req.method !== "POST" || !isInitializeRequest(body)) {
    res.writeHead(400, { "content-type": "application/json" });
    return res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "No valid MCP session" }, id: null }));
  }
  const target = new URL(req.url ?? "", "http://x").searchParams.get("block") ?? "inspect.session";
  try {
    agentId(target);
  } catch (e) {
    res.writeHead(404, { "content-type": "application/json" });
    return res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: (e as Error).message }, id: null }));
  }
  const server = createServer(target);
  const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      conns.set(id, { server, transport, target, lastTools: JSON.stringify(toolsFor(sync.state, agentId(target))) });
    },
  });
  transport.onclose = () => {
    if (transport.sessionId) conns.delete(transport.sessionId);
  };
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
