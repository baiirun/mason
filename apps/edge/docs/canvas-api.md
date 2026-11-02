# Canvas and blocks API

Which blocks exist, where they sit, and how clients and agents watch and drive them. Writing a block's code is a separate API: see [block-code-api.md](block-code-api.md). Canvas operations never touch git, and commits never create, move or remove blocks.

Each item is marked **Implemented** (in `apps/edge`, the local prototype) or **Planned** (the Cloudflare target).

## Concepts

| Term | Meaning |
|---|---|
| Canvas | A workspace's set of block instances and their layout. One Canvas DO per workspace; Planned: persisted to Postgres. |
| Block (instance) | A running module on the canvas, with its own data, state and Block DO. |
| Version policy | `"head"`: follow the module's latest published version. `{ pinned: <version id> }`: stay on one version. |
| Op | The only way to change the canvas. The UI and agents send the same ops. |

### Instance

```ts
interface Instance {
  id: string;                               // stable; also names the Block DO
  module: string;                           // blocks/<module>.tsx
  version: "head" | { pinned: string };
  versionId: string;                        // version currently running, e.g. "oncall-desk@03ecaef"
  props: Record<string, unknown>;           // the module's block.props
  rect: { x: number; y: number; w: number; h: number };  // canvas px
  z: number;                                // stacking order
  principal: string;                        // whose credentials the block's calls use
}
```

Implemented.

## Ops

| Op | Fields | Effect |
|---|---|---|
| `open` | `module`; optional `id`, `props`, `near`, `rect` (partial), `pin` | Creates a block on the module's head (pinned to it if `pin`). Placed beside `near`, else to the right of the newest block if it fits in a 1360px row, else on a new row. Default size 640×420. The id defaults to `<module>-<6 hex>`. |
| `move` | `id`, `x`, `y` | Layout only. Rounded, clamped to ≥ 0. |
| `resize` | `id`, `w`, `h` | Layout only. Minimum 240×140. |
| `raise` | `id` | Brings the block to the front. |
| `setProps` | `id`, `props` | Replaces props. The block re-evaluates; unchanged queries aren't refetched. |
| `close` | `id` | Removes the block, its subscriptions and its Block DO's data. |

Errors (HTTP `400` / ack `ok: false`): the module has no published version; the id already exists; `near` or `id` doesn't exist; unknown op.

Each applied op increments the canvas `seq`, is appended to an op log (last 200) with its actor, and is broadcast to every canvas viewer. Implemented. Planned: undo from the log; permission checks per principal; spaces and zoom/pan.

## HTTP

| Method & path | Body | Response | Status |
|---|---|---|---|
| `GET /api/canvas` | | `{ type: "snapshot", seq, blocks: (Instance & { client })[] }` | Implemented |
| `POST /api/canvas/ops` | an op | `{ seq, op, block }`: `op` with defaults filled in (e.g. the generated id and rect) | Implemented |
| `GET /api/modules` | | `[{ module, versionId }]`: published modules and their heads | Implemented |
| `GET /api/blocks/:id` | | the agent view (below) | Implemented |
| `POST /api/blocks/:id/state` | `{ key, value }` | `{ ok: true }` | Implemented |
| `POST /api/blocks/:id/actions/:name` | `{ input, confirmed? }` | `{ result }` | Implemented |
| `POST /api/blocks/:id/refresh` | | `{ ok: true }` | Implemented |
| `GET /api/blocks` | | `[{ id, module, version, props, rect, client }]` (compatibility view) | Implemented |
| `POST /api/seed` | | Publishes every module at head; opens `canvas.json` on an empty canvas. Dev only. | Implemented |

`client` is `{ hex, sri }`: the client bundle's sha256 (hex) and its subresource-integrity string.

Actor: the prototype records `user:byron`. Planned: the authenticated principal or agent session, checked against canvas and block permissions.

### Agent view: `GET /api/blocks/:id`

```ts
{
  id, module, version, commit, principal,
  describe: string | null,          // from the module's block.describe
  errors: string[],                 // setup/describe errors
  outline: {
    query, tool, args,
    status: "pending" | "waiting" | "ready" | "error",
    rows: number, fetchedAt: number | null,
    freshness: string,              // "live via <topic>" | "polled every Ns while observed" | "fetched on change"
    error?: string
  }[],
  actions: { name, tool, invalidates: string[], permission }[],
  state: Record<string, unknown>,
  viewers: number,
  offset: number,
  sandbox: { envKeys: string[], fetch: string }   // prototype diagnostics
}
```

Implemented. Planned: `rows` on request (`?query=<name>&limit=`), a view outline from `@mason/ui`, a screenshot, recent view errors, and `events`: the block's recent emitted events (envelopes, see [Events and automations](block-code-api.md#events-and-automations-planned)).

## Canvas WebSocket: `GET /api/canvas/ws`

One socket per viewer; hibernatable.

Server → client:

| Message | When |
|---|---|
| `{ type: "snapshot", seq, blocks }` | On connect. |
| `{ type: "op", seq, op, actor, block? }` | After any op. `block` (with `client`) is present unless the op was `close`. |
| `{ type: "version", seq, id, versionId, block }` | A publish moved a block to a new version; `block.client` is the new bundle. |
| `{ type: "ack", id, ok, seq? , error? }` | Reply to an op this client sent. |

Client → server: `{ type: "op", id, op }`.

Clients apply ops as they arrive and may move a card locally while dragging, sending one `move`/`resize` on release. Implemented. Planned: resume by `seq`.

## Block data WebSocket: `GET /api/blocks/:id/ws[?since=<offset>]`

A block's change stream, straight from its Block DO. Every server message carries an `offset` that increases by one.

Server → client:

| Message | Meaning |
|---|---|
| `{ type: "snapshot", offset, block, values, state, describe, errors, actions }` | Full state. `values[query] = { rows, status, args, fetchedAt, error?, key }`. Sent first, unless resuming. |
| `{ type: "change", offset, query, ops, status, fetchedAt?, error? }` | `ops`: `{ op: "insert" \| "update" \| "delete", key, value? }`, keyed by the query's `key`. |
| `{ type: "state", offset, key, value }` | State changed. |
| `{ type: "meta", offset, describe, errors, actions }` | Describe line, errors or actions changed. |
| `{ type: "version", offset, versionId, client }` | The block moved to a new version. |
| `{ type: "ack", id, ok, result? , error? }` | Reply to an action. Not in the offset sequence. |

Client → server: `{ type: "action", id, name, input, confirmed? }`, `{ type: "setState", key, value }`, `{ type: "refresh" }`.

Resume: with `?since=<offset>`, the DO replays the messages after that offset if it still has them (last 200, in memory), else sends a snapshot. A connected socket counts as an observer: polling runs only while at least one is open. Implemented.

## Embedding a block view

The host renders each block in:

```html
<iframe sandbox="allow-scripts" src="<frame origin>/frame?h=<client.hex>&i=<client.sri>"></iframe>
```

The frame origin is separate from the app's. The shell loads the client bundle with an `integrity` check, under CSP `default-src 'none'; script-src <frame origin> 'nonce-…'; connect-src 'none'; img-src data: blob:`.

Handshake: after the iframe loads, the host posts `{ type: "mason:init" }` with a `MessagePort`, then relays the block data socket over it.

| Direction | Messages |
|---|---|
| Host → frame | Everything from the block data socket. |
| Frame → host | `{ type: "ready" }`, `{ type: "size", height }`, `{ type: "action", id, name, input, confirmed? }`, `{ type: "setState", key, value }`, `{ type: "refresh" }`, `{ type: "error", message }` |

The host forwards `action`, `setState` and `refresh` to the block socket and routes `ack`s back. On a `version` message from the canvas, the host points the iframe at the new bundle and reconnects. Implemented.

## Webhook ingress

`POST /webhook/github` stands in for a GitHub delivery. Body: `{ repo, number?, ci?, title?, reviewers? }`, applied to the mock GitHub. The platform maps the event to topics, looks up subscribed blocks in the topic index, and wakes only those. Response: `{ pr, topics, woke }`. Implemented (simulated). Planned: real signed deliveries through an ingress Worker and queue.

## MCP tools for agents (Planned)

The same operations, for agents that reach the platform over MCP:

| Tool | Maps to |
|---|---|
| `canvas_get` | `GET /api/canvas` |
| `canvas_open`, `canvas_move`, `canvas_resize`, `canvas_set_props`, `canvas_close` | `POST /api/canvas/ops` |
| `modules_list` | `GET /api/modules` |
| `block_read` | `GET /api/blocks/:id` (plus rows and screenshot when added) |
| `block_action`, `block_set_state`, `block_refresh` | the block endpoints |

Each tool call carries the agent session's principal and, for automation sessions, the run id. The canvas checks the principal like a person's op; the Block DO records the run id as the cause of the change, which events emitted from it inherit (the loop guard).
