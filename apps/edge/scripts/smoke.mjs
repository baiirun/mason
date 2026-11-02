// End-to-end checks against a running `npm run dev` (wrangler dev on :8787).
import { createHash } from "node:crypto";

const BASE = process.env.BASE ?? "http://localhost:8787";
const WS_BASE = BASE.replace(/^http/, "ws");
let failed = 0;

function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
}
const post = (path, body) => fetch(BASE + path, { method: "POST", body: JSON.stringify(body ?? {}) }).then((r) => r.json().then((j) => ({ status: r.status, ...j })));
const get = (path) => fetch(BASE + path).then((r) => r.json());

/** A socket that records every message and lets a test wait for one matching a predicate. */
function open(blockId, since) {
  const ws = new WebSocket(`${WS_BASE}/api/blocks/${blockId}/ws${since != null ? `?since=${since}` : ""}`);
  const seen = [];
  const waiters = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    seen.push(m);
    for (const w of [...waiters]) if (w.pred(m)) (waiters.splice(waiters.indexOf(w), 1), w.resolve(m));
  };
  const until = (pred, ms = 4000) =>
    new Promise((resolve, reject) => {
      const hit = seen.find(pred);
      if (hit) return resolve(hit);
      const w = { pred, resolve };
      waiters.push(w);
      setTimeout(() => reject(new Error("timed out")), ms);
    });
  return { ws, seen, until, ready: new Promise((r) => (ws.onopen = r)), send: (m) => ws.send(JSON.stringify(m)) };
}

await post("/api/seed");

// The agent's view of a block, read straight from its DO.
const web = await get("/api/blocks/web-desk");
check("describe line comes from the block's own setup", /inspect\/web: \d+ of \d+ open PRs/.test(web.describe), web.describe);
check("PR query is live via its webhook topic", web.outline.find((q) => q.query === "prs")?.freshness === "live via github:repo:inspect/web:pulls");
check("p95 query is polled", web.outline.find((q) => q.query === "p95")?.freshness.startsWith("polled every 5s"));
check("isolate has no bindings", Array.isArray(web.sandbox.envKeys) && web.sandbox.envKeys.length === 0);
check("isolate fetch() is blocked", web.sandbox.fetch.startsWith("blocked"), web.sandbox.fetch);

const esc = await get("/api/blocks/escape");
const secrets = esc.outline.find((q) => q.query === "secrets");
check("gateway refuses a tool outside the block's grant", secrets?.status === "error" && /not allowed by block escape's grant/.test(secrets.error), secrets?.error);
// Regression: parallel fetches used to overwrite each other's cached rows.
check("a failing query doesn't clobber its sibling", esc.outline.find((q) => q.query === "prs")?.status === "ready");

// Push: a webhook reaches the subscribed block and nothing else.
const sock = open("web-desk");
await sock.ready;
const snap = await sock.until((m) => m.type === "snapshot");
check("viewer gets a snapshot first", snap.values.prs.rows.length > 0);
const hook = await post("/webhook/github", { repo: "inspect/web", number: 12, ci: "failing" });
// escape-attempts also lists inspect/web PRs, so it is a subscriber too; api-desk is not.
check("webhook wakes only blocks on that repo's topic", hook.woke.includes("web-desk") && hook.woke.includes("escape") && !hook.woke.includes("api-desk"), JSON.stringify(hook.woke));
const upd = await sock.until((m) => m.type === "change" && m.query === "prs" && m.ops.some((o) => o.op === "update" && o.value.number === 12 && o.value.ci === "failing"));
check("webhook arrives as a keyed row update", !!upd, `offset ${upd.offset}`);
await post("/webhook/github", { repo: "inspect/web", title: "Smoke PR", reviewers: ["byron"] });
const ins = await sock.until((m) => m.type === "change" && m.query === "prs" && m.ops.some((o) => o.op === "insert" && o.value.title === "Smoke PR"));
check("new upstream PR arrives as an insert", !!ins);
await sock.until((m) => m.type === "meta" && /failing CI/.test(m.describe ?? ""));
check("describe recomputes from new data", true);

// Actions: confirm-gated, single flight.
const target = ins.ops.find((o) => o.op === "insert").value;
sock.send({ type: "action", id: 1, name: "close", input: { repo: "inspect/web", number: target.number } });
const denied = await sock.until((m) => m.type === "ack" && m.id === 1);
check("confirm action refuses without confirmation", denied.ok === false && /needs confirmation/.test(denied.error), denied.error);
sock.send({ type: "action", id: 2, name: "close", input: { repo: "inspect/web", number: target.number }, confirmed: true });
const del = await sock.until((m) => m.type === "change" && m.ops.some((o) => o.op === "delete" && o.key === String(target.id)));
const ack = await sock.until((m) => m.type === "ack" && m.id === 2);
check("action refetches what it invalidates before acking", ack.ok && seenBefore(sock.seen, del, ack));

// State: a view edit re-evaluates setup.
sock.send({ type: "setState", key: "reviewer", value: "maya" });
const meta = await sock.until((m) => m.type === "meta" && /need maya/.test(m.describe ?? ""));
check("state change re-runs setup", !!meta, meta.describe);
sock.send({ type: "setState", key: "reviewer", value: "byron" });
await sock.until((m) => m.type === "meta" && /need byron/.test(m.describe ?? ""));

// Resume from an offset instead of a fresh snapshot.
const last = sock.seen.at(-1).offset;
sock.ws.close();
await post("/webhook/github", { repo: "inspect/web", number: 12, ci: "passing" });
await new Promise((r) => setTimeout(r, 300));
const again = open("web-desk", last);
await again.ready;
const first = await again.until(() => true);
check("reconnect with ?since replays the gap, not a snapshot", first.type !== "snapshot" && first.offset === last + 1, `${first.type} @ ${first.offset}`);
again.ws.close();

// Polling only while observed.
const api = open("api-desk");
await api.ready;
await api.until((m) => m.type === "snapshot");
const polled = await api.until((m) => m.type === "change" && m.query === "p95", 8000).catch(() => null);
check("p95 is re-polled while someone watches", !!polled);
api.ws.close();

// The view's bundle and frame.
const blocks = await get("/api/blocks");
const b = blocks.find((x) => x.id === "web-desk");
const frame = await fetch(`${BASE.replace("localhost", "127.0.0.1")}/frame?h=${b.client.hex}&i=${encodeURIComponent(b.client.sri)}`);
const csp = frame.headers.get("content-security-policy") ?? "";
check("frame CSP blocks all network", csp.includes("connect-src 'none'") && csp.includes("default-src 'none'"), csp);
const bundle = await fetch(`${BASE}/bundles/client/${b.client.hex}.js`).then((r) => r.text());
const sri = "sha256-" + createHash("sha256").update(bundle).digest("base64");
check("client bundle matches its integrity hash", sri === b.client.sri);

// The compiler's gate.
const badImport = await post("/api/modules", { moduleId: "bad", source: `import fs from "node:fs"; export default { id: "x", setup() { fs.readFileSync("/etc/passwd") } }` });
check("compile rejects imports outside the SDK", badImport.status === 422, badImport.error);
const token = await post("/api/modules", { moduleId: "bad", source: `const t = "ghp_${"a".repeat(30)}"; export default {}` });
check("compile rejects pasted tokens", token.status === 422, token.error);
const notABlock = await post("/api/modules", { moduleId: "bad", source: `export default {}` });
check("compile rejects a module that isn't a Block.define", notABlock.status === 422, notABlock.error);

function seenBefore(list, a, b) {
  return list.indexOf(a) < list.indexOf(b);
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
