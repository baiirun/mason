# edge: Block DO prototype

A throwaway prototype of live blocks on Cloudflare Workers, run locally with `wrangler dev` (workerd/miniflare). It tests one slice of the design: block code lives in a git repo that agents clone and push like any other code; a Durable Object per block runs that code in a sandboxed isolate, keeps its data fresh by push or poll, and streams it into a sandboxed view. Postgres, the MCP gateway and Cloudflare Artifacts are mocked.

```
npm run dev -w @mason/edge          # git stand-in on :8788 + wrangler dev on :8787
curl -X POST localhost:8787/api/seed   # publish everything at the repo's head
open http://localhost:8787          # the stand-in canvas
npm run smoke -w @mason/edge        # end-to-end checks against the running dev servers
```

## Editing blocks

The workspace repo has one file per module, plus an agent guide (`AGENTS.md`), SDK types and a starting layout:

```
blocks/oncall-desk.tsx       export default Block.define({ id, setup, view })
blocks/escape-attempts.tsx
AGENTS.md, CLAUDE.md         how to write blocks, the tools, the push output, the canvas API
types/mason-sdk.d.ts         so `npx tsc -p .` checks blocks
canvas.json                  opened once on an empty canvas by /api/seed; not synced after that
```

Agents (or you) work on it with plain git:

```
git clone http://agent:dev-token@localhost:8787/git/workspace.git
# edit blocks/oncall-desk.tsx or canvas.json, commit
git push
remote: mason: blocks/oncall-desk.tsx → oncall-desk@ad4f41e; reloaded api-desk, web-desk
```

On a push that moves `main`, the Worker compiles each changed module and the canvas switches every block following that module's head to the new version in place: state and cached rows stay, unchanged queries aren't refetched, dropped queries are pruned, and open views reload the iframe with the new bundle. Pinned blocks stay put. A module that fails to compile is reported in the push output and its blocks keep running the previous version. The version id is the commit.

## The canvas

Which blocks exist, their props, version policy and layout belong to a server-owned Canvas DO (`worker/canvas-do.ts`), changed only by ops: `open`, `move`, `resize`, `raise`, `setProps`, `close`. The page and agents use the same path: the page sends ops over its canvas WebSocket (drag a card by its header, resize by its corner, Add, ✕), agents `POST /api/canvas/ops`. Every op is broadcast to everyone watching. Commits never move or create blocks, and canvas ops never touch git.

```
curl -s localhost:8787/api/canvas
curl -s -X POST localhost:8787/api/canvas/ops -d '{"type":"open","module":"ci-board","near":"web-desk"}'
```

## What's real and what's mocked

| Piece | Here |
|---|---|
| Git remote (`worker/git.ts`) | Real smart-HTTP proxy in the Worker: checks credentials, forwards to the repo host, publishes after a push, and adds `remote: mason:` lines to the push output. |
| Repo host (`scripts/git-server.mjs`, `worker/repo.ts`) | Stand-in for Cloudflare Artifacts: `git http-backend` over a bare repo in `.git-data/`, plus Artifacts-shaped reads (log, readFile, changed paths). With real Artifacts, `worker/repo.ts` becomes the `env.ARTIFACTS` binding. |
| Block DO (`worker/block-do.ts`) | Real. One per block: cached query rows in DO storage, state, a change stream with offsets, poll alarms only while a viewer is connected, hibernatable sockets, in-place version switches. |
| Block code isolate (`worker/isolate.ts`) | Real Worker Loader isolate, keyed by the bundle's sha256, `env: {}`, `globalOutbound: null`. |
| Compiler (`worker/compile.ts`) | Sucrase in the Worker. Rejects imports other than `@mason/sdk`, pasted tokens, and modules that aren't a `Block.define`. Writes content-addressed server and client bundles to R2. |
| View sandbox (`worker/pages.ts`, `frame/sdk.tsx`) | Real. `sandbox="allow-scripts"` iframe on a second origin (127.0.0.1 vs localhost), CSP `default-src 'none'; connect-src 'none'`, bundle loaded with an `integrity` hash, one MessagePort to the host. |
| Postgres (`worker/registry-do.ts`) | Mock DO: module versions and heads, block records, the `block_subscriptions` topic index. |
| MCP gateway + GitHub + Datadog (`worker/gateway-do.ts`) | Mock DO: takes each call with the block's grant (block and principal); fake PRs; a p95 metric that can only be polled. |
| Canvas DO (`worker/canvas-do.ts`) | Real. Block instances (module, head or pinned version, props, rect, z) and an op log; one hibernatable socket per viewer. Would also persist to Postgres. Each card still opens its own socket to its Block DO for data. |

## How a block runs

- **Server half.** The Block DO sends the isolate a snapshot (props, state, current query values) and gets back what `setup` wants as data: queries with resolved args, actions, the describe line. The isolate is stateless, so eviction is harmless. The DO does all I/O through the gateway and re-evaluates until dependent queries settle.
- **Freshness.** Queries register webhook topics in the index (`github:repo:<repo>:pulls`). `POST /webhook/github` looks up subscribers and wakes only those blocks. Sources with no push (`refresh: "5s"`) poll from a DO alarm while someone is watching.
- **Wire.** The DO sends a snapshot, then keyed row ops (`insert`/`update`/`delete`) with offsets. A socket that reconnects with `?since=<offset>` gets the gap replayed instead of a snapshot. A `version` message tells the view to load a new bundle.
- **Actions.** `block.action(name, tool, { invalidates, permission })`. `confirm` actions are refused without confirmation. The DO refetches what an action invalidates before acking, then fans the change out to other blocks.
- **Agents.** Code: the git repo. Runtime: `GET /api/blocks/:id` returns the describe line, version and commit, and an outline of each query's tool, args, status and freshness.

`blocks/escape-attempts.tsx` tries network, storage, the parent document and a tool that doesn't exist; the canvas shows each one blocked.

## Known gaps

- Re-evaluating `setup` on every change is simple but does more work than tracked signals.
- The change log for resuming lives in memory; after the DO is evicted, a reconnect gets a snapshot.
- The server and client bundles are the same compiled code; view code is present in the isolate (never called) and setup code in the iframe.
- No `@mason/sdk` type declarations yet, so `tsc` can't check blocks.
- No zoom or pan yet, no approvals for new tool capabilities, no per-principal visibility rules, no undo, no branches or preview canvases.
- Agents can't see the rendered UI or rows (only the outline), as discussed.
