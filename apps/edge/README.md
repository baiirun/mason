# edge: Block DO prototype

A throwaway prototype of live blocks on Cloudflare Workers, run locally with `wrangler dev` (workerd/miniflare). It tests one slice of the design: a Durable Object per block that runs agent-written block code in a sandboxed isolate, keeps its data fresh by push or poll, and streams it into a sandboxed view. Postgres and the MCP gateway are mocked.

```
npm run dev -w @mason/edge          # builds the frame runtime, then wrangler dev on :8787
curl -X POST localhost:8787/api/seed
open http://localhost:8787          # the stand-in canvas
npm run smoke -w @mason/edge        # end-to-end checks against the running dev server
```

## What's real and what's mocked

| Piece | Here |
|---|---|
| Block DO (`worker/block-do.ts`) | Real. One per block: cached query rows in DO storage, state, a change stream with offsets, poll alarms only while a viewer is connected, hibernatable sockets. |
| Block code isolate (`worker/isolate.ts`) | Real Worker Loader isolate, keyed by the bundle's sha256, `env: {}`, `globalOutbound: null`. |
| Compiler (`worker/compile.ts`) | Sucrase in the Worker. Rejects imports other than `@mason/sdk`, pasted tokens, and modules that aren't a `Block.define`. Writes content-addressed server and client bundles to R2. |
| View sandbox (`worker/pages.ts`, `frame/sdk.tsx`) | Real. `sandbox="allow-scripts"` iframe on a second origin (127.0.0.1 vs localhost), CSP `default-src 'none'; connect-src 'none'`, bundle loaded with an `integrity` hash, one MessagePort to the host. |
| Postgres (`worker/registry-do.ts`) | Mock DO: module versions, block records, the `block_subscriptions` topic index. |
| MCP gateway + GitHub + Datadog (`worker/gateway-do.ts`) | Mock DO: checks each call against the block grant; fake PRs; a p95 metric that can only be polled. |
| Canvas DO | Skipped. Each card opens its own socket to its Block DO. |

## How a block runs

A block is one TSX file: `export default Block.define({ id, tools, setup, view })` (see `examples/`).

- **Server half.** The Block DO sends the isolate a snapshot (props, state, current query values) and gets back what `setup` wants as data: queries with resolved args, actions, the describe line. The isolate is stateless, so eviction is harmless. The DO does all I/O through the gateway and re-evaluates until dependent queries settle.
- **Freshness.** Queries register webhook topics in the index (`github:repo:<repo>:pulls`). `POST /webhook/github` looks up subscribers and wakes only those blocks. Sources with no push (`refresh: "5s"`) poll from a DO alarm while someone is watching.
- **Wire.** The DO sends a snapshot, then keyed row ops (`insert`/`update`/`delete`) with offsets. A socket that reconnects with `?since=<offset>` gets the gap replayed instead of a snapshot.
- **Actions.** `block.action(name, tool, { invalidates, permission })`. `confirm` actions are refused without confirmation. The DO refetches what an action invalidates before acking, then fans the change out to other blocks.
- **Agents.** `GET /api/blocks/:id` returns the describe line and an outline of each query's tool, args, status and freshness.

`examples/escape.tsx` tries network, storage, the parent document and a tool outside its grant; the canvas shows each one blocked.

## Known gaps

- Re-evaluating `setup` on every change is simple but does more work than tracked signals.
- The change log for resuming lives in memory; after the DO is evicted, a reconnect gets a snapshot.
- The server and client bundles are the same compiled code; view code is present in the isolate (never called) and setup code in the iframe.
- No Canvas DO, no approvals, no per-principal visibility rules, no hot reload of new versions.
