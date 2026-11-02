// Git-backed blocks, end to end: an agent clones the workspace repo through the
// Worker's git remote, edits a block with ordinary tools, pushes, and the open
// block switches to the new code with its state kept. Needs `npm run dev`.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.BASE ?? "http://localhost:8787";
const REMOTE = BASE.replace("://", "://agent:dev-token@") + "/git/workspace.git";
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};
const get = (p) => fetch(BASE + p).then((r) => r.json());
const post = (p, body) => fetch(BASE + p, { method: "POST", body: JSON.stringify(body ?? {}) }).then((r) => r.json());

const dir = mkdtempSync(join(tmpdir(), "mason-agent-"));
const git = (...args) =>
  execFileSync("git", ["-c", "user.name=agent", "-c", "user.email=agent@localhost", ...args], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
/** Push and return everything git printed (it writes `remote:` lines to stderr). */
const push = (refspec = "main") => execFileSync("sh", ["-c", `git push -f origin ${refspec} 2>&1 || true`], { cwd: dir, encoding: "utf8" });
const edit = (path, fn) => writeFileSync(join(dir, path), fn(readFileSync(join(dir, path), "utf8")));
const commitAndPush = (msg) => {
  git("commit", "-qam", msg);
  return push();
};

/** Watch a block's socket for a message matching pred. */
function watch(blockId) {
  const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/api/blocks/${blockId}/ws`);
  const seen = [];
  ws.onmessage = (e) => seen.push(JSON.parse(e.data));
  const until = async (pred, ms = 5000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = seen.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 50));
    }
    return null;
  };
  return { ws, seen, until, ready: new Promise((r) => (ws.onopen = r)) };
}

let start = "main";
try {
  await post("/api/seed");

  // An unauthenticated clone is refused.
  let refused = false;
  try {
    execFileSync("git", ["-c", "credential.helper=", "ls-remote", `${BASE}/git/workspace.git`], { stdio: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  } catch {
    refused = true;
  }
  check("the git remote requires credentials", refused);

  // Clone like any repo.
  // No credential helper: nothing gets saved to the keychain.
  execFileSync("git", ["-c", "credential.helper=", "clone", "-q", "--config", "credential.helper=", REMOTE, dir], { stdio: "pipe" });
  check("agent clones the workspace through the Worker", readFileSync(join(dir, "blocks/oncall-desk.tsx"), "utf8").includes("Block.define"));
  start = git("rev-parse", "HEAD").trim();

  // A second block on the same module, pinned to the current version.
  const pinnedOp = await post("/api/canvas/ops", { type: "open", id: "pinned-desk", module: "oncall-desk", props: { repo: "inspect/web" }, pin: true });
  const pinnedVersion = pinnedOp.block?.versionId;
  check("a block can be pinned to a version", pinnedOp.block?.version?.pinned === pinnedVersion, pinnedVersion);

  // Put the block in a known state with a viewer watching.
  await post("/api/blocks/web-desk/state", { key: "reviewer", value: "maya" });
  const before = await get("/api/blocks/web-desk");
  const prsFetchedAt = before.outline.find((q) => q.query === "prs").fetchedAt;
  const viewer = watch("web-desk");
  await viewer.ready;

  // Edit the block's code with plain string replacement, commit, push.
  edit("blocks/oncall-desk.tsx", (s) => s.replace("open PRs need", "open PRs are waiting on"));
  const out = commitAndPush("Reword the describe line");
  check("push output reports what was published", /remote: mason: blocks\/oncall-desk\.tsx → oncall-desk@[0-9a-f]{7}; reloaded [^;]*web-desk/.test(out), out.split("\n").filter((l) => l.includes("mason:")).join(" | "));
  check("pinned blocks are reported and not moved", /pinned, not moved: pinned-desk/.test(out) && (await get("/api/blocks/pinned-desk")).version === pinnedVersion);

  const ver = await viewer.until((m) => m.type === "version");
  check("open viewers are told to load the new bundle", !!ver, ver?.versionId);
  const after = await get("/api/blocks/web-desk");
  check("the block runs the new code", /open PRs are waiting on maya/.test(after.describe ?? ""), after.describe);
  check("block state survived the code change", after.state.reviewer === "maya");
  check("unchanged queries weren't refetched", after.outline.find((q) => q.query === "prs").fetchedAt === prsFetchedAt);
  check("version id is the commit", after.commit?.startsWith(after.version.split("@")[1]), `${after.version} / ${after.commit?.slice(0, 7)}`);

  // A change that drops a query prunes it.
  edit("blocks/oncall-desk.tsx", (s) => s.replace(/\s*const p95 = block\.query\([^;]*;\n/, "\n    const p95 = { value: undefined } as any;\n"));
  commitAndPush("Drop the p95 query");
  await new Promise((r) => setTimeout(r, 300));
  const pruned = await get("/api/blocks/web-desk");
  check("a query removed from the code is dropped", !pruned.outline.some((q) => q.query === "p95") && pruned.outline.some((q) => q.query === "prs"));

  // Broken code is rejected and the block keeps running the last good version.
  const good = pruned.version;
  edit("blocks/oncall-desk.tsx", (s) => s.replace(`from "@mason/sdk";`, `from "@mason/sdk";\nimport fs from "node:fs";\nfs;`));
  const bad = commitAndPush("Import node:fs");
  check("a bad import is refused in the push output", /not published: import "node:fs" is not allowed/.test(bad), bad.split("\n").find((l) => l.includes("mason:")));
  check("the block stays on its previous version", (await get("/api/blocks/web-desk")).version === good);
  git("revert", "--no-edit", "HEAD");
  push();

  edit("blocks/oncall-desk.tsx", (s) => s.replace(`id: "oncall-desk",`, `id: "oncall-desk", token: "ghp_${"a".repeat(30)}",`));
  check("a pasted token is refused", /not published: source looks like it contains a token/.test(commitAndPush("Paste a token")));
  git("revert", "--no-edit", "HEAD");
  push();

  // The canvas is server-owned and changed by ops, not by commits.
  const canvasWs = new WebSocket(`${BASE.replace(/^http/, "ws")}/api/canvas/ws`);
  const canvasMsgs = [];
  canvasWs.onmessage = (e) => canvasMsgs.push(JSON.parse(e.data));
  await new Promise((r) => (canvasWs.onopen = r));
  const web = (await get("/api/canvas")).blocks.find((b) => b.id === "web-desk");
  const opened = await post("/api/canvas/ops", { type: "open", id: "ops-desk", module: "oncall-desk", props: { repo: "inspect/api" }, near: "web-desk" });
  check("open places a block next to another", opened.block?.rect.x === web.rect.x + web.rect.w + 16 && opened.block?.rect.y === web.rect.y, JSON.stringify(opened.block?.rect));
  check("the new block runs", /inspect\/api:/.test((await get("/api/blocks/ops-desk")).describe ?? ""));
  await post("/api/canvas/ops", { type: "move", id: "ops-desk", x: 40, y: 900 });
  check("move changes layout only", JSON.stringify((await get("/api/canvas")).blocks.find((b) => b.id === "ops-desk").rect) === JSON.stringify({ ...opened.block.rect, x: 40, y: 900 }));
  await new Promise((r) => setTimeout(r, 200));
  check("viewers of the canvas get each op", ["open", "move"].every((t) => canvasMsgs.some((m) => m.type === "op" && m.op.type === t && m.op.id === "ops-desk")));
  const badOp = await fetch(`${BASE}/api/canvas/ops`, { method: "POST", body: JSON.stringify({ type: "open", module: "nope" }) });
  check("an op for an unpublished module is refused", badOp.status === 400, (await badOp.json()).error);
  git("commit", "-q", "--allow-empty", "-m", "Empty commit");
  push();
  check("a push doesn't move or remove blocks", (await get("/api/canvas")).blocks.some((b) => b.id === "ops-desk" && b.rect.y === 900));
  await post("/api/canvas/ops", { type: "close", id: "ops-desk" });
  check("close removes the block", !(await get("/api/canvas")).blocks.some((b) => b.id === "ops-desk"));
  canvasWs.close();

  viewer.ws.close();
} catch (e) {
  console.error(e);
  failed++;
}
// Put the repo and the block back as they were, through the same push path.
try {
  push(`${start}:main`);
  await post("/api/blocks/web-desk/state", { key: "reviewer", value: "byron" });
  for (const id of ["pinned-desk", "ops-desk"]) await post("/api/canvas/ops", { type: "close", id });
} catch {}
rmSync(dir, { recursive: true, force: true });
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
