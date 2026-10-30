import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientMsg, Op, ServerMsg } from "@mason/core";
import { callTool, manifest, resolveBlock, toolsFor } from "./agent/context";
import { handleUserMessage } from "./agent/fakeAgent";
import { db, onDbChange, resetDb, setDoc } from "./inspect/db";
import type { DataMsg } from "./inspect/types";
import { handleMcp } from "./mcp";
import { onOp, resetWorkspace, submit, sync } from "./workspace";

const PORT = Number(process.env.PORT ?? 4317);
// Simulated latency for trying out the optimistic path: LATENCY=400 npm run dev
const LATENCY = Number(process.env.LATENCY ?? 0);

const send = (ws: WebSocket, msg: ServerMsg | DataMsg) => {
  const data = JSON.stringify(msg);
  if (LATENCY) setTimeout(() => ws.readyState === ws.OPEN && ws.send(data), LATENCY);
  else ws.send(data);
};

// ---- layout socket: the optimistic op log --------------------------------------

const layoutSockets = new Set<WebSocket>();
const layoutWss = new WebSocketServer({ noServer: true });
onOp((msg) => layoutSockets.forEach((ws) => send(ws, msg)));
layoutWss.on("connection", (ws) => {
  layoutSockets.add(ws);
  let clientId = "anon";
  ws.on("message", (data) => {
    const msg = JSON.parse(String(data)) as ClientMsg;
    if (msg.type === "hello") {
      clientId = msg.clientId;
      send(ws, sync.snapshot(clientId));
    } else if (msg.type === "op") {
      const res = submit(clientId, msg.op, msg.clientOpId);
      if (res.type === "reject") send(ws, res);
    }
  });
  ws.on("close", () => layoutSockets.delete(ws));
});

// ---- data socket: the stand-in inspect backend pushes its data -----------------

const dataSockets = new Set<WebSocket>();
const dataWss = new WebSocketServer({ noServer: true });
let dataTimer: NodeJS.Timeout | undefined;
onDbChange(() => {
  // Coalesce bursts (streaming tokens) into one push per frame-ish.
  clearTimeout(dataTimer);
  dataTimer = setTimeout(() => dataSockets.forEach((ws) => send(ws, { type: "db", db })), 16);
});
dataWss.on("connection", (ws) => {
  dataSockets.add(ws);
  send(ws, { type: "db", db });
  ws.on("close", () => dataSockets.delete(ws));
});

// ---- HTTP ------------------------------------------------------------------------

async function readBody(req: IncomingMessage) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : undefined;
}
function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(data));
}

const http = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const path = url.pathname;
  try {
    if (path === "/mcp") return await handleMcp(req, res, req.method === "POST" ? await readBody(req) : undefined);

    if (req.method === "GET" && path === "/api/state") return json(res, 200, { version: sync.version, state: sync.state });

    if (req.method === "POST" && path === "/api/ops") {
      // Agents and scripts drive the layout with the same ops as the UI.
      const { ops, op, clientId = "http" } = (await readBody(req)) ?? {};
      const results = ((ops ?? [op]) as Op[]).map((o) => submit(clientId, o));
      return json(res, results.some((r) => r.type === "reject") ? 409 : 200, { version: sync.version, results });
    }

    if (req.method === "POST" && path === "/api/reset") {
      resetWorkspace();
      resetDb();
      for (const ws of layoutSockets) ws.close(4000, "reset");
      return json(res, 200, { ok: true });
    }

    // What an agent in a block sees, and calling its tools (the same thing MCP exposes).
    if (req.method === "GET" && path === "/api/agent/context") {
      const b = resolveBlock(sync.state, url.searchParams.get("block") ?? "");
      if (!b) return json(res, 404, { error: "no such block" });
      return json(res, 200, { blockId: b.id, manifest: manifest(sync.state, b.id), tools: toolsFor(sync.state, b.id) });
    }
    if (req.method === "POST" && path === "/api/agent/call") {
      const { block, name, args = {} } = (await readBody(req)) ?? {};
      const b = resolveBlock(sync.state, block ?? "");
      if (!b) return json(res, 404, { error: "no such block" });
      return json(res, 200, { result: await callTool(b.id, name, args, "cli") });
    }

    // Stand-in inspect backend.
    const msg = path.match(/^\/api\/sessions\/([^/]+)\/messages$/);
    if (req.method === "POST" && msg) {
      const { text, blockId } = (await readBody(req)) ?? {};
      void handleUserMessage(msg[1]!, String(text), blockId).catch((e) => console.error(e));
      return json(res, 202, { ok: true });
    }
    const doc = path.match(/^\/api\/docs\/([^/]+)$/);
    if (req.method === "POST" && doc) {
      const { body } = (await readBody(req)) ?? {};
      setDoc(doc[1]!, (d) => ({ ...d, body: String(body) }));
      return json(res, 200, { ok: true });
    }

    json(res, 404, { error: "not found" });
  } catch (e) {
    if (!res.headersSent) json(res, 400, { error: (e as Error).message });
  }
});

http.on("upgrade", (req, socket, head) => {
  const path = new URL(req.url ?? "/", "http://x").pathname;
  const wss = path === "/ws" ? layoutWss : path === "/data" ? dataWss : null;
  if (!wss) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

http.listen(PORT, () =>
  console.log(`mason server on http://localhost:${PORT}  (ws /ws layout, /data inspect data, /mcp agents, /api/*)`),
);
