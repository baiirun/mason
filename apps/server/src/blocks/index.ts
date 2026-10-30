// Server-side half of each block kind: what it tells agents about itself, and the
// tools agents (and the CLI) can call on it. The React half lives in apps/web.
import { findStack, uid, type BlockRecord, type Workspace } from "@mason/core";
import { db, pushMessage, setDoc, setSession } from "../inspect/db";
import { submit } from "../workspace";

export type Permission = "read" | "write" | "confirm";

export interface ToolCtx {
  block: BlockRecord;
  ws: Workspace;
  /** Who's calling, for the op log: "agent:<blockId>", "mcp:<id>", "cli". */
  actor: string;
}

export interface KindTool {
  /** Tool name exposed to agents. Letters, digits, _ and - only (Claude API rule). */
  name: string;
  description: string;
  /** JSON Schema properties, besides the blockId every kind tool takes. */
  properties?: Record<string, unknown>;
  required?: string[];
  /** Metadata for now: "confirm" tools should ask the person first (not enforced yet). */
  permission: Permission;
  run(ctx: ToolCtx, args: Record<string, any>): unknown;
}

export interface ServerBlockDef {
  kind: string;
  /** One line for the agent's manifest: what this block is and what's in it. */
  describe(block: BlockRecord, ws: Workspace): { title: string; summary: string };
  /** Full content, for read_block. */
  read?(block: BlockRecord, ws: Workspace): string;
  tools?: KindTool[];
}

const sessionOf = (b: BlockRecord) => (b.state.sessionId ? db.sessions[b.state.sessionId as string] : undefined);
const docOf = (b: BlockRecord) => db.docs[b.state.docId as string];
const childrenOf = (id: string) => Object.values(db.sessions).filter((c) => c.parentId === id);

/** Blocks that follow their link group: resolve the session they currently show. */
export function followedSession(b: BlockRecord, ws: Workspace) {
  const own = sessionOf(b);
  if (own) return own;
  if (!b.link) return undefined;
  // The server doesn't know which session each client last focused; use the first linked session block.
  const src = Object.values(ws.blocks).find((x) => x.kind === "inspect.session" && x.link === b.link);
  return src && sessionOf(src);
}

export const serverBlocks: ServerBlockDef[] = [
  {
    kind: "inspect.doc",
    describe: (b) => {
      const d = docOf(b);
      if (!d) return { title: "Doc (missing)", summary: "doc not found" };
      const lines = d.body.split("\n").filter((l) => l.trim()).length;
      return { title: `Doc “${d.title}”`, summary: `${lines} non-empty lines; starts “${d.body.slice(0, 60).replace(/\n/g, " ")}”` };
    },
    read: (b) => docOf(b)?.body ?? "",
    tools: [
      {
        name: "doc_append",
        description: "Append markdown to the end of a doc. The person sees it appear live.",
        properties: { text: { type: "string" } },
        required: ["text"],
        permission: "write",
        run: ({ block }, { text }) => {
          setDoc(block.state.docId as string, (d) => ({ ...d, body: d.body + text }));
          return "appended";
        },
      },
      {
        name: "doc_replace",
        description: "Replace the whole body of a doc.",
        properties: { text: { type: "string" } },
        required: ["text"],
        permission: "write",
        run: ({ block }, { text }) => {
          setDoc(block.state.docId as string, (d) => ({ ...d, body: text }));
          return "replaced";
        },
      },
      {
        name: "doc_edit",
        description: "Replace the first occurrence of `find` with `replace` in a doc.",
        properties: { find: { type: "string" }, replace: { type: "string" } },
        required: ["find", "replace"],
        permission: "write",
        run: ({ block }, { find, replace }) => {
          const d = docOf(block);
          if (!d?.body.includes(find)) throw new Error("text to find is not in the doc");
          setDoc(d.id, (x) => ({ ...x, body: x.body.replace(find, replace) }));
          return "edited";
        },
      },
    ],
  },
  {
    kind: "inspect.session",
    describe: (b) => {
      const s = sessionOf(b);
      if (!s) return { title: "Session (missing)", summary: "session not found" };
      const last = [...s.messages].reverse().find((m) => m.role === "agent" || m.role === "user");
      return { title: `Session “${s.name}”`, summary: `${s.status}, ${s.diffs.length} changed files; last: “${last?.text.slice(0, 80) ?? ""}”` };
    },
    read: (b) => {
      const s = sessionOf(b);
      if (!s) return "";
      const msgs = s.messages.filter((m) => m.role === "user" || m.role === "agent").slice(-12);
      return [`# ${s.name} (${s.status})`, ...msgs.map((m) => `${m.role}: ${m.text}`), "", "Changed files:", ...s.diffs.map((d) => `- ${d.path} (+${d.added} −${d.removed})`)].join("\n");
    },
    tools: [
      {
        name: "session_send",
        description: "Send a message to another agent session.",
        properties: { text: { type: "string" } },
        required: ["text"],
        permission: "write",
        run: ({ block, actor }, { text }) => {
          pushMessage(block.state.sessionId as string, { role: "user", text: `[from ${actor}] ${text}` });
          return "sent";
        },
      },
      {
        name: "session_interrupt",
        description: "Stop a running session.",
        permission: "confirm",
        run: ({ block }) => {
          setSession(block.state.sessionId as string, (s) => ({ ...s, status: "idle" }));
          return "interrupted";
        },
      },
    ],
  },
  {
    kind: "inspect.session.diffs",
    describe: (b, ws) => {
      const s = followedSession(b, ws);
      if (!s) return { title: "Diffs", summary: "not linked to a session" };
      return { title: `Diffs of “${s.name}”`, summary: s.diffs.map((d) => `${d.path} (+${d.added} −${d.removed})`).join(", ") || "no changes" };
    },
    read: (b, ws) => {
      const s = followedSession(b, ws);
      return s ? s.diffs.map((d) => d.patch).join("\n\n") || "no changes" : "not linked";
    },
    tools: [
      {
        name: "diffs_open_file",
        description: "Open one changed file's diff as a tab next to a diffs block.",
        properties: { path: { type: "string" } },
        required: ["path"],
        permission: "write",
        // A kind tool can change the layout too: it goes through the same op log as the UI.
        run: ({ block, ws, actor }, { path }) => {
          const s = followedSession(block, ws);
          if (!s?.diffs.some((d) => d.path === path)) throw new Error(`no diff for ${path}`);
          const space = ws.spaces.find((sp) => findStack(sp.root, block.id))!;
          const res = submit(actor, {
            type: "openBlock",
            spaceId: space.id,
            block: { id: uid("block-"), kind: "inspect.diff", state: { sessionId: s.id, path }, link: null },
            at: { mode: "tab", target: block.id },
          });
          return res.type === "op" ? "opened" : `rejected: ${res.reason}`;
        },
      },
    ],
  },
  {
    kind: "inspect.session.children",
    describe: (b, ws) => {
      const s = followedSession(b, ws);
      if (!s) return { title: "Child sessions", summary: "not linked to a session" };
      const kids = childrenOf(s.id);
      return { title: `Child sessions of “${s.name}”`, summary: kids.map((k) => `${k.name} (${k.status}, ${k.diffs.length} files)`).join(", ") || "none" };
    },
    read: (b, ws) => {
      const s = followedSession(b, ws);
      if (!s) return "not linked";
      return childrenOf(s.id)
        .map((c) => [`## ${c.name} (${c.status})`, ...c.messages.slice(-3).map((m) => `${m.role}: ${m.text}`), ...c.diffs.map((d) => `- ${d.path} (+${d.added} −${d.removed})`)].join("\n"))
        .join("\n\n");
    },
  },
  {
    kind: "inspect.diff",
    describe: (b) => ({ title: `Diff of ${b.state.path}`, summary: `${sessionOf(b)?.name ?? "unknown session"}` }),
    read: (b) => sessionOf(b)?.diffs.find((d) => d.path === b.state.path)?.patch ?? "",
  },
  {
    kind: "inspect.preview",
    describe: (b, ws) => {
      const s = followedSession(b, ws);
      return s ? { title: `Preview of “${s.name}”`, summary: `${s.previewUrl}, built from ${s.diffs.length} changed files` } : { title: "Preview", summary: "not linked" };
    },
    read: (b, ws) => {
      const s = followedSession(b, ws);
      return s ? `URL: ${s.previewUrl}\nPage title: ${s.name}\nConsole: no errors` : "not linked";
    },
  },
];

export const defOf = (kind: string) => serverBlocks.find((d) => d.kind === kind);
