// The server-owned layout: one SyncServer, persisted to data/workspace.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SyncServer, type Op, type ServerMsg, type Workspace } from "@mason/core";
import { seedWorkspace } from "./seed";

const FILE = join(dirname(fileURLToPath(import.meta.url)), "../data/workspace.json");

function load(): { state: Workspace; version: number } {
  if (existsSync(FILE)) return JSON.parse(readFileSync(FILE, "utf8"));
  return { state: seedWorkspace(), version: 0 };
}
const initial = load();
export const sync = new SyncServer(initial.state, initial.version);

let saveTimer: NodeJS.Timeout | undefined;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify({ version: sync.version, state: sync.state }, null, 2));
  }, 250);
}

const listeners = new Set<(msg: ServerMsg) => void>();
/** Called with every applied op (to broadcast to browsers, notify MCP clients...). */
export const onOp = (fn: (msg: ServerMsg) => void) => listeners.add(fn);

let seq = 0;
/** Apply an op from any source (browser, agent, CLI, MCP) and fan it out. */
export function submit(clientId: string, op: Op, clientOpId = `${clientId}:${Date.now()}:${++seq}`) {
  const res = sync.submit(clientId, clientOpId, op);
  if (res.type === "op") {
    listeners.forEach((l) => l(res));
    save();
    console.log(`v${res.version} ${clientId} ${op.type}`);
  } else console.log(`reject ${clientId} ${op.type}: ${res.reason}`);
  return res;
}

export function resetWorkspace() {
  sync.state = seedWorkspace();
  sync.version++;
  save();
}
