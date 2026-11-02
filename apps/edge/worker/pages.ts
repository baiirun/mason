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
  header { padding: 18px 24px 8px; display:flex; flex-wrap:wrap; gap:12px; align-items:baseline; }
  header h1 { font-size:18px; margin:0; }
  header p { margin:0; color:var(--muted); }
  .sim { padding: 0 24px 12px; display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
  .sim span { color:var(--muted); margin-right:4px; }
  button { font:inherit; border:1px solid var(--line); background:var(--surface); color:var(--fg); border-radius:6px; padding:4px 10px; cursor:pointer; }
  button:hover { border-color: var(--accent); }
  .desk { display:grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 460px), 1fr)); gap:16px; padding: 8px 24px 32px; }
  .card { background:var(--surface); border:1px solid var(--line); border-radius:10px; display:flex; flex-direction:column; min-width:0; }
  .card-head { padding:10px 12px; border-bottom:1px solid var(--line); display:grid; gap:4px; }
  .card-head .top { display:flex; gap:8px; align-items:center; }
  .card-head strong { font-size:13px; }
  .card-head .meta { margin-left:auto; color:var(--muted); font-family: ui-monospace, Menlo, monospace; font-size:11px; }
  .describe { color:var(--muted); font-size:12px; }
  .describe::before { content:"agent sees: "; color:var(--accent); }
  iframe { border:0; width:100%; height:120px; display:block; background:var(--surface); border-radius:0 0 10px 10px; }
  details { padding: 0 12px 10px; }
  details pre { max-height: 260px; overflow:auto; background:var(--bg); padding:8px; border-radius:6px; }
  .dot { width:8px; height:8px; border-radius:50%; background:var(--muted); }
  .dot.on { background: var(--good); }
</style></head>
<body>
<header><h1>Block DO prototype</h1><p>Each card is a Block DO streaming into a sandboxed view on ${env.FRAME_ORIGIN}.</p></header>
<div class="sim"><span>Simulate a GitHub webhook:</span>
  <button data-hook='{"repo":"inspect/web","number":12,"ci":"failing"}'>web#12 CI fails</button>
  <button data-hook='{"repo":"inspect/web","number":12,"ci":"passing"}'>web#12 CI passes</button>
  <button data-hook='{"repo":"inspect/web","title":"Add minimap","reviewers":["byron"]}'>New PR in web</button>
  <button data-hook='{"repo":"inspect/api","title":"Rate limit per grant","reviewers":["byron"]}'>New PR in api</button>
</div>
<main class="desk" id="desk"></main>
<script type="module">
const FRAME = ${JSON.stringify(env.FRAME_ORIGIN)};
const desk = document.getElementById("desk");

for (const b of document.querySelectorAll("[data-hook]")) {
  b.onclick = () => fetch("/webhook/github", { method: "POST", body: b.dataset.hook });
}

function mount(block) {
  const card = document.createElement("article");
  card.className = "card";
  card.innerHTML = \`<div class="card-head"><div class="top"><span class="dot"></span><strong></strong>
      <span class="meta"></span><button class="refresh">Refresh</button></div><div class="describe"></div></div>
    <iframe sandbox="allow-scripts" referrerpolicy="no-referrer" title="block view"></iframe>
    <details><summary>Agent view (describe + outline)</summary><pre>…</pre></details>\`;
  card.querySelector("strong").textContent = block.module + " · " + block.id;
  desk.append(card);
  const frame = card.querySelector("iframe");
  const meta = card.querySelector(".meta");
  const describeEl = card.querySelector(".describe");
  const dot = card.querySelector(".dot");
  const pre = card.querySelector("pre");
  card.querySelector("details").addEventListener("toggle", async (e) => {
    if (e.target.open) pre.textContent = JSON.stringify(await (await fetch("/api/blocks/" + block.id)).json(), null, 2);
  });
  frame.src = FRAME + "/frame?h=" + block.client.hex + "&i=" + encodeURIComponent(block.client.sri);

  let port = null, ws = null, offset = null;
  card.querySelector(".refresh").onclick = () => ws?.send(JSON.stringify({ type: "refresh" }));

  frame.addEventListener("load", () => {
    const ch = new MessageChannel();
    port = ch.port1;
    port.onmessage = (e) => {
      const m = e.data;
      if (m.type === "size") frame.style.height = Math.min(Math.max(m.height, 80), 640) + "px";
      else if (m.type === "action" || m.type === "setState" || m.type === "refresh") ws?.send(JSON.stringify(m));
      else if (m.type === "error") console.warn(block.id, "view error:", m.message);
    };
    frame.contentWindow.postMessage({ type: "mason:init" }, "*", [ch.port2]);
    connect();
  });

  function connect() {
    const q = offset == null ? "" : "?since=" + offset;
    ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/api/blocks/" + block.id + "/ws" + q);
    ws.onopen = () => dot.classList.add("on");
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (typeof m.offset === "number") offset = m.offset;
      meta.textContent = "offset " + offset;
      if (m.type === "snapshot" || m.type === "meta") describeEl.textContent = m.describe ?? "";
      port?.postMessage(m);
    };
    ws.onclose = () => { dot.classList.remove("on"); setTimeout(connect, 1000); };
  }
}

const blocks = await (await fetch("/api/blocks")).json();
if (!blocks.length) desk.innerHTML = "<p>No blocks yet. POST /api/seed to create the examples.</p>";
blocks.forEach(mount);
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
