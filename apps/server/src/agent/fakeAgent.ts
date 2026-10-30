// A scripted stand-in for a real agent. It uses exactly what a real agent would get:
// the manifest from manifest() at the start of the turn and tools via callTool().
import { addSession, db, pushMessage, setLastMessage, setSession } from "../inspect/db";
import { sync } from "../workspace";
import { agentBlockForSession, callTool, manifest, scope } from "./context";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function say(sessionId: string, text: string) {
  pushMessage(sessionId, { role: "agent", text: "" });
  const words = text.split(" ");
  for (let i = 1; i <= words.length; i++) {
    setLastMessage(sessionId, words.slice(0, i).join(" "));
    await sleep(25);
  }
}

async function tool(sessionId: string, agentId: string, name: string, args: Record<string, unknown>, label: string) {
  pushMessage(sessionId, { role: "tool", text: `${name}(${label})` });
  await sleep(250);
  return callTool(agentId, name, args);
}

export async function handleUserMessage(sessionId: string, text: string, blockId?: string) {
  const session = db.sessions[sessionId];
  if (!session) throw new Error(`session ${sessionId} not found`);
  pushMessage(sessionId, { role: "user", text });
  setSession(sessionId, (s) => ({ ...s, status: "running" }));
  try {
    const agentId = blockId && sync.state.blocks[blockId] ? blockId : agentBlockForSession(sessionId);
    if (!agentId) return say(sessionId, "I'm not open in any space, so I can't see anything around me.");
    // What a real agent would get in its system prompt this turn:
    pushMessage(sessionId, { role: "context", text: manifest(sync.state, agentId) });
    await sleep(200);

    if (/release notes|changelog/i.test(text)) return await writeReleaseNotes(sessionId, agentId);
    if (/what can you see|around you|context/i.test(text)) {
      const { blocks } = scope(sync.state, agentId);
      return await say(sessionId, blocks.length ? `I can see ${blocks.length} blocks: ${blocks.map((b) => `${b.title} (${b.position})`).join("; ")}.` : "Nothing around me yet.");
    }
    return await genericReply(sessionId, text);
  } finally {
    setSession(sessionId, (s) => ({ ...s, status: "idle" }));
  }
}

async function writeReleaseNotes(sessionId: string, agentId: string) {
  const { blocks } = scope(sync.state, agentId);
  const docs = blocks.filter((b) => b.block.kind === "inspect.doc");
  const doc = docs.find((d) => /release|changelog|notes/i.test(d.title)) ?? docs[0];
  if (!doc) {
    return say(sessionId, "There's no doc around me to write into. Open one next to me (or say which) and ask again.");
  }
  const sources = blocks.filter((b) => ["inspect.session.diffs", "inspect.session.children", "inspect.session"].includes(b.block.kind));
  if (!sources.length) return say(sessionId, `I found ${doc.title}, but nothing around me to write release notes about.`);

  await say(sessionId, `Writing release notes into ${doc.title} from ${sources.length} blocks around me.`);
  const read: string[] = [];
  for (const src of sources) read.push(await tool(sessionId, agentId, "read_block", { blockId: src.block.id }, src.title));

  // "Model output": turn what was read into notes. A real agent would reason over `read`.
  const files = [...new Set((read.join("\n").match(/(?:[\w.-]+\/)+[\w.-]+\.\w+/g) ?? []).map((f) => f.replace(/^[ab]\//, "")))];
  const kids = read.join("\n").match(/^## (.+) \((idle|running)\)$/gm)?.map((l) => l.replace(/^## /, "")) ?? [];
  const sessionNames = sources.filter((s) => s.block.kind !== "inspect.session.children").map((s) => s.title.replace(/^.*“(.+)”.*$/, "$1"));
  const lines = [
    `### ${[...new Set(sessionNames)].join(", ")}`,
    ...files.map((f) => `- ${describeFile(f)} (\`${f}\`)`),
    ...kids.map((k) => `- Work from “${k.replace(/ \((idle|running)\)$/, "")}”${/running/.test(k) ? " (still in progress)" : ""}`),
    "",
  ];
  for (const line of lines) await tool(sessionId, agentId, "doc_append", { blockId: doc.block.id, text: line + "\n" }, `${doc.title}, ${JSON.stringify(line.slice(0, 40))}`);
  await say(sessionId, `Done: ${files.length} changes and ${kids.length} child sessions are in ${doc.title}.`);
}

function describeFile(path: string) {
  const name = path.split("/").pop()!.replace(/\.\w+$/, "");
  if (/test/.test(path)) return `Added tests for ${name.replace(/\.test$/, "")}`;
  if (/^use[A-Z]/.test(name)) return `New ${name}() hook`;
  if (/refresh/.test(name)) return "Tokens refresh in the background";
  if (/login/.test(name)) return "Login page no longer manages session state";
  return `Updated ${name}`;
}

async function genericReply(sessionId: string, text: string) {
  const replies = [
    "Looking through the code now. I found the place this belongs and I'm making the change.",
    "Done. I updated the component and added a test for the edge case you mentioned.",
    "That touches a few files. I'll start a child session for the migration so this one stays focused.",
  ];
  const reply = replies[Math.floor(Math.random() * replies.length)]!;
  await say(sessionId, reply);
  const file = ["src/app.tsx", "src/api/client.ts", "src/components/Button.tsx", "README.md"][Math.floor(Math.random() * 4)]!;
  setSession(sessionId, (s) => ({
    ...s,
    diffs: [
      ...s.diffs.filter((d) => d.path !== file),
      { path: file, added: 3 + Math.floor(Math.random() * 30), removed: Math.floor(Math.random() * 12), patch: `--- a/${file}\n+++ b/${file}\n+// ${text.slice(0, 60)}` },
    ],
  }));
  if (reply.includes("child session")) {
    const id = `s-${Math.random().toString(36).slice(2, 7)}`;
    addSession({ id, name: `Migration for “${text.slice(0, 24)}”`, parentId: sessionId, status: "running", messages: [{ role: "agent", text: "Starting the migration." }], diffs: [], previewUrl: `http://localhost:3000/${id}` });
  }
}
