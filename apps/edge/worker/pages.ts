// The host page (a stand-in canvas) and the sandboxed frame shell each block view runs in.

const TOKENS = `
  :root { --bg:#f3f4f7; --surface:#fff; --fg:#1a1f2b; --muted:#5e6678; --line:#d9dde5; --accent:#2f5bd3;
          --good:#1f8a4c; --warn:#b7791f; --bad:#c53030; color-scheme: light; }
  @media (prefers-color-scheme: dark) { :root { --bg:#11141a; --surface:#191d25; --fg:#e3e7ee; --muted:#9aa3b2;
          --line:#2b313d; --accent:#7c9cf5; --good:#4ade80; --warn:#fbbf24; --bad:#f87171; color-scheme: dark; } }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  code, pre { font-family: ui-monospace, "SFMono-Regular", Menlo, monospace; font-size: 12px; }
`;

export function hostPage(env: { FRAME_ORIGIN: string }) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Block DO prototype</title>
<style>${TOKENS}
  header { padding: 14px 20px 6px; display:flex; flex-wrap:wrap; gap:12px; align-items:baseline; }
  header h1 { font-size:18px; margin:0; }
  header p { margin:0; color:var(--muted); }
  .bar { padding: 0 20px 10px; display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
  .bar span { color:var(--muted); }
  .bar .sep { width:1px; height:20px; background:var(--line); margin:0 6px; }
  button, select, input { font:inherit; border:1px solid var(--line); background:var(--surface); color:var(--fg); border-radius:6px; padding:4px 10px; }
  button { cursor:pointer; } button:hover { border-color: var(--accent); }
  input { width: 130px; }
  .desk { position:relative; margin: 0 20px 40px; min-height: 70vh; border:1px dashed var(--line); border-radius:12px;
          background-image: radial-gradient(var(--line) 1px, transparent 1px); background-size: 24px 24px; overflow:auto; }
  .desk.dragging iframe { pointer-events:none; }
  .card { position:absolute; background:var(--surface); border:1px solid var(--line); border-radius:10px; display:flex; flex-direction:column;
          box-shadow: 0 6px 24px rgba(0,0,0,.18); overflow:hidden; }
  .card-head { padding:8px 10px; border-bottom:1px solid var(--line); display:grid; gap:3px; cursor:grab; user-select:none; }
  .desk.dragging .card-head { cursor:grabbing; }
  .card-head .top { display:flex; gap:8px; align-items:center; min-width:0; }
  .card-head strong { font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .card-head .meta { margin-left:auto; color:var(--muted); font-family: ui-monospace, Menlo, monospace; font-size:11px; white-space:nowrap; }
  .card-head button { padding:1px 8px; font-size:12px; }
  .describe { color:var(--muted); font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .describe::before { content:"agent sees: "; color:var(--accent); }
  .body { position:relative; flex:1; min-height:0; }
  iframe { border:0; width:100%; height:100%; display:block; background:var(--surface); }
  .agent { position:absolute; inset:0; margin:0; padding:10px; overflow:auto; background:var(--bg); font-size:11px; }
  .grip { position:absolute; right:0; bottom:0; width:16px; height:16px; cursor:nwse-resize;
          background: linear-gradient(135deg, transparent 50%, var(--muted) 50%); opacity:.5; }
  .dot { width:8px; height:8px; border-radius:50%; background:var(--muted); flex:none; }
  .dot.on { background: var(--good); }
  .toast { position:fixed; bottom:16px; left:50%; transform:translateX(-50%); background:var(--surface); border:1px solid var(--bad);
           color:var(--fg); padding:8px 14px; border-radius:8px; }
</style></head>
<body>
<header><h1>Block DO prototype</h1><p>The canvas is server-owned: drag, resize, add and close go through canvas ops. Block code changes go through git.</p></header>
<div class="bar">
  <span>Add a block:</span>
  <select id="module"></select>
  <input id="repo" placeholder="repo prop (optional)">
  <button id="add">Add</button>
  <span class="sep"></span>
  <span>Simulate a GitHub webhook:</span>
  <button data-hook='{"repo":"inspect/web","number":12,"ci":"failing"}'>web#12 CI fails</button>
  <button data-hook='{"repo":"inspect/web","number":12,"ci":"passing"}'>web#12 CI passes</button>
  <button data-hook='{"repo":"inspect/web","title":"Add minimap","reviewers":["byron"]}'>New PR in web</button>
  <button data-hook='{"repo":"inspect/api","title":"Rate limit per grant","reviewers":["byron"]}'>New PR in api</button>
</div>
<main class="desk" id="desk"></main>
<script type="module">
const FRAME = ${JSON.stringify(env.FRAME_ORIGIN)};
const wsBase = (location.protocol === "https:" ? "wss://" : "ws://") + location.host;
const desk = document.getElementById("desk");
const cards = new Map();

for (const b of document.querySelectorAll("[data-hook]")) {
  b.onclick = () => fetch("/webhook/github", { method: "POST", body: b.dataset.hook });
}
function toast(text) {
  const t = Object.assign(document.createElement("div"), { className: "toast", textContent: text });
  document.body.append(t);
  setTimeout(() => t.remove(), 4000);
}

// ---- canvas ops: one socket, server-owned state --------------------------------
let canvasWs = null, nextOp = 0;
const pendingOps = new Map();
function op(o) {
  const id = ++nextOp;
  canvasWs?.send(JSON.stringify({ type: "op", id, op: o }));
  return new Promise((resolve) => pendingOps.set(id, resolve));
}
function connectCanvas() {
  canvasWs = new WebSocket(wsBase + "/api/canvas/ws");
  canvasWs.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === "snapshot") {
      const ids = new Set(m.blocks.map((b) => b.id));
      for (const [id, c] of cards) if (!ids.has(id)) { c.remove(); cards.delete(id); }
      for (const b of m.blocks) cards.has(b.id) ? cards.get(b.id).place(b) : mount(b);
    } else if (m.type === "op") {
      if (m.op.type === "close") { cards.get(m.op.id)?.remove(); cards.delete(m.op.id); }
      else if (m.block) cards.has(m.block.id) ? cards.get(m.block.id).place(m.block) : mount(m.block);
    } else if (m.type === "version") {
      cards.get(m.id)?.place(m.block);
    } else if (m.type === "ack") {
      pendingOps.get(m.id)?.(m);
      pendingOps.delete(m.id);
      if (!m.ok) toast(m.error);
    }
    fit();
  };
  canvasWs.onclose = () => setTimeout(connectCanvas, 1000);
}
function fit() {
  let bottom = 0;
  for (const c of cards.values()) bottom = Math.max(bottom, c.rect.y + c.rect.h);
  desk.style.height = Math.max(bottom + 40, window.innerHeight * 0.7) + "px";
}

// ---- add a block ----------------------------------------------------------------
const select = document.getElementById("module");
async function loadModules() {
  const mods = await (await fetch("/api/modules")).json();
  select.innerHTML = mods.map((m) => '<option value="' + m.module + '">' + m.module + "</option>").join("");
}
document.getElementById("add").onclick = () => {
  const repo = document.getElementById("repo").value.trim();
  op({ type: "open", module: select.value, props: repo ? { repo } : {} });
};

// ---- a card: one block's view, positioned by the canvas -------------------------
function mount(block) {
  const card = document.createElement("article");
  card.className = "card";
  card.innerHTML = \`<div class="card-head"><div class="top"><span class="dot"></span><strong></strong>
      <span class="meta"></span><button class="agent-btn" title="What an agent reads about this block">Agent view</button>
      <button class="refresh">Refresh</button><button class="close" title="Close block">✕</button></div>
      <div class="describe"></div></div>
    <div class="body"><iframe sandbox="allow-scripts" referrerpolicy="no-referrer" title="block view"></iframe>
      <pre class="agent" hidden></pre><div class="grip" title="Resize"></div></div>\`;
  desk.append(card);
  const head = card.querySelector(".card-head");
  const title = card.querySelector("strong");
  const frame = card.querySelector("iframe");
  const meta = card.querySelector(".meta");
  const describeEl = card.querySelector(".describe");
  const dot = card.querySelector(".dot");
  const agent = card.querySelector(".agent");
  let current = block, port = null, ws = null, offset = null, bundle = null;

  card.rect = block.rect;
  card.place = (b) => {
    current = b;
    card.style.zIndex = b.z;
    if (!card.dragging) {
      // Don't snap back to the server's rect while this client is mid-drag.
      card.rect = b.rect;
      Object.assign(card.style, { left: b.rect.x + "px", top: b.rect.y + "px", width: b.rect.w + "px", height: b.rect.h + "px" });
    }
    const pin = b.version === "head" ? "" : " (pinned)";
    title.textContent = b.id + " · " + b.versionId + pin;
    if (b.client && b.client.hex !== bundle) {
      bundle = b.client.hex;
      frame.src = FRAME + "/frame?h=" + b.client.hex + "&i=" + encodeURIComponent(b.client.sri);
    }
  };
  const remove = card.remove.bind(card);
  card.remove = () => { if (ws) { ws.onclose = null; ws.close(); } remove(); };
  card.place(block);
  cards.set(block.id, card);

  card.querySelector(".refresh").onclick = () => ws?.send(JSON.stringify({ type: "refresh" }));
  card.querySelector(".close").onclick = () => op({ type: "close", id: current.id });
  card.querySelector(".agent-btn").onclick = async () => {
    agent.hidden = !agent.hidden;
    if (!agent.hidden) agent.textContent = JSON.stringify(await (await fetch("/api/blocks/" + current.id)).json(), null, 2);
  };

  // Drag by the header; resize by the corner. Local while moving, one op on release.
  head.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button")) return;
    op({ type: "raise", id: current.id });
    drag(e, (dx, dy, r) => ({ x: Math.max(0, r.x + dx), y: Math.max(0, r.y + dy) }), (r) => op({ type: "move", id: current.id, x: r.x, y: r.y }));
  });
  card.querySelector(".grip").addEventListener("pointerdown", (e) =>
    drag(e, (dx, dy, r) => ({ w: Math.max(240, r.w + dx), h: Math.max(140, r.h + dy) }), (r) => op({ type: "resize", id: current.id, w: r.w, h: r.h })),
  );
  function drag(e, change, commit) {
    e.preventDefault();
    const start = { ...card.rect }, sx = e.clientX, sy = e.clientY;
    card.dragging = true;
    desk.classList.add("dragging");
    const move = (ev) => {
      const r = { ...start, ...change(ev.clientX - sx, ev.clientY - sy, start) };
      Object.assign(card.style, { left: r.x + "px", top: r.y + "px", width: r.w + "px", height: r.h + "px" });
      card.rect = r;
    };
    const up = () => {
      card.dragging = false;
      desk.classList.remove("dragging");
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      commit(card.rect);
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  }

  // The view's own data stream, straight from its Block DO.
  frame.addEventListener("load", () => {
    if (ws) { ws.onclose = null; ws.close(); ws = null; offset = null; }
    const ch = new MessageChannel();
    port = ch.port1;
    port.onmessage = (e) => {
      const m = e.data;
      if (m.type === "action" || m.type === "setState" || m.type === "refresh") ws?.send(JSON.stringify(m));
      else if (m.type === "error") console.warn(current.id, "view error:", m.message);
    };
    frame.contentWindow.postMessage({ type: "mason:init" }, "*", [ch.port2]);
    connect();
  });
  function connect() {
    const q = offset == null ? "" : "?since=" + offset;
    ws = new WebSocket(wsBase + "/api/blocks/" + current.id + "/ws" + q);
    ws.onopen = () => dot.classList.add("on");
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (typeof m.offset === "number") offset = m.offset;
      meta.textContent = "offset " + offset;
      if (m.type === "snapshot" || m.type === "meta") describeEl.textContent = m.describe ?? "";
      if (m.type === "version") return; // the canvas sends the new bundle
      port?.postMessage(m);
    };
    ws.onclose = () => { dot.classList.remove("on"); if (card.isConnected) setTimeout(connect, 1000); };
  }
  return card;
}

await loadModules();
connectCanvas();
</script>
</body></html>`;
}

/** The frame shell. Served from FRAME_ORIGIN; the iframe has an opaque origin (sandbox without allow-same-origin). */
export function frameShell(origin: string, hex: string, sri: string, nonce: string) {
  const importMap = JSON.stringify({
    imports: { "@mason/sdk": `${origin}/runtime/sdk.js`, "@mason/sdk/jsx-runtime": `${origin}/runtime/sdk.js`, react: `${origin}/runtime/sdk.js` },
  });
  const html = `<!doctype html>
<html><head><meta charset="utf-8">
<style>${TOKENS}
  body { padding: 12px; }
  .m-stack { display:grid; gap:12px; }
  .m-row { display:flex; flex-wrap:wrap; gap:12px; align-items:end; }
  .m-stat { display:grid; gap:2px; padding:8px 12px; border:1px solid var(--line); border-radius:8px; min-width:110px; }
  .m-stat span { color:var(--muted); font-size:12px; }
  .m-stat strong { font-size:20px; font-variant-numeric: tabular-nums; }
  .m-stat.good strong { color:var(--good); } .m-stat.warn strong { color:var(--warn); } .m-stat.bad strong { color:var(--bad); }
  .m-field { display:grid; gap:2px; color:var(--muted); font-size:12px; }
  .m-section h3 { font-size:12px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); margin:0 0 6px; }
  .m-table { width:100%; border-collapse:collapse; font-size:13px; }
  .m-table th { text-align:left; color:var(--muted); font-weight:500; padding:4px 6px; border-bottom:1px solid var(--line); }
  .m-table td { padding:6px; border-bottom:1px solid var(--line); }
  .m-badge { display:inline-block; padding:1px 8px; border-radius:999px; font-size:11px; border:1px solid currentColor; }
  .m-badge.good { color:var(--good); } .m-badge.warn { color:var(--warn); } .m-badge.bad { color:var(--bad); }
  .m-muted { color:var(--muted); margin:0; }
  .m-error { color:var(--bad); white-space:pre-wrap; }
  .m-list { margin:0; padding-left:18px; }
  button, select { font:inherit; border:1px solid var(--line); background:var(--surface); color:var(--fg); border-radius:6px; padding:3px 8px; }
  button { cursor:pointer; } button:disabled { opacity:.6; cursor:default; }
</style>
<script type="importmap" nonce="${nonce}">${importMap}</script>
</head><body>
<div id="root"></div>
<script type="module" src="${origin}/bundles/client/${hex}.js" integrity="${sri}" crossorigin="anonymous"></script>
<script type="module" nonce="${nonce}">import { boot } from "@mason/sdk"; boot();</script>
</body></html>`;
  // The view can run scripts from this origin only and talk to nothing: its one way out is the MessagePort.
  const csp = [
    "default-src 'none'",
    `script-src ${origin} 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": csp, "cache-control": "no-store" } });
}
