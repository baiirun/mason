# Block code API

How a block's code is written, checked and published. Which blocks exist and where they sit is a separate API: see [canvas-api.md](canvas-api.md).

Each item is marked **Implemented** (in `apps/edge`, the local prototype) or **Planned** (the Cloudflare target: Artifacts, cloud agents, MCP).

## Concepts

| Term | Meaning |
|---|---|
| Workspace repo | A git repository holding a workspace's block code. Local stand-in today; Cloudflare Artifacts in production. |
| Module | One file, `blocks/<module>.tsx`. The filename is the module id: lowercase letters, digits and `-`. |
| Version | A module compiled at a commit. Id: `<module>@<commit sha, 7 chars>`. Immutable. |
| Head | The latest published version of a module on `main`. Blocks that follow head move to it on publish. |
| Block | A running instance of a module on the canvas. Defined by the canvas API, not by code. |

## Repository layout

```
blocks/<module>.tsx      one module per file
types/mason-sdk.d.ts     types for @mason/sdk
tsconfig.json            `npx tsc -p .` type-checks every module
AGENTS.md, CLAUDE.md     the guide agents read
canvas.json              optional starting layout, applied once to an empty canvas (not synced)
```

Implemented.

## Module format

A module's default export is a `Block.define` call. `@mason/sdk` is the only import allowed.

```tsx
import { Block, Section, Table, type PullRequest } from "@mason/sdk";

export default Block.define<{ repo: string }>({
  id: "open-prs",
  setup(block, ctx) { ... },
  view(props) { ... },
});
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | yes | Module id. Should match the filename. |
| `setup` | `(block, ctx) => void` | yes | Runs on the server in a sandbox. Declares data; never fetches it. |
| `view` | `(props) => JSX` | no | Runs in the browser in a sandboxed iframe. Omit for a headless block. |

The `Props` type parameter types `block.props`, which come from the canvas.

## `setup(block, ctx)`

Runs in a Worker Loader isolate with no bindings and no network (`fetch` throws). It is evaluated again whenever props, state or query values change, so it must be synchronous and side-effect free. The platform does all I/O.

### `block.props: Props`

The block's props from the canvas. Read-only. Implemented.

### `block.state<T>(key, initial): { name, value }`

Persistent per-block state. `value` is the stored value or `initial`. The view changes it with `setState(key, value)`; agents with `POST /api/blocks/:id/state`. State survives code changes. Implemented.

### `block.query<Args, Row>(name, tool, args, opts?): { name, value, status }`

Declares a live tool call.

| Param | Meaning |
|---|---|
| `name` | Unique within the module. The view reads rows as `data[name]`. |
| `tool` | `ctx.mcp.<server>.<tool>`. |
| `args` | `() => Args \| null`. Re-evaluated on every change; a new result means a new call. Return `null` to wait (dependent queries). Must be synchronous. |
| `opts.refresh` | Poll interval (`"500ms"`, `"30s"`, `"5m"`) for sources that can't push. Polling only runs while the block is observed. |
| `opts.key` | Row field used as identity for diffs. Default `id`. |

Returns `value` (rows, or `undefined` before the first fetch) and `status`: `pending`, `waiting` (args were `null`), `ready` or `error`.

Freshness is decided by the platform, not the module: tools with push sources (GitHub webhooks) update when an event touches their topic; others poll if `refresh` is set; any query refetches when its args change or someone refreshes the block. A result that isn't an array is wrapped as one row with `id: "value"`. Implemented.

### `block.action<Args>(name, tool, opts?)`

Declares a write the view or an agent can trigger.

| Option | Meaning |
|---|---|
| `invalidates` | Queries (handles or names) refetched before the action resolves. |
| `permission` | `read`, `write` (default) or `confirm`. A `confirm` action is refused unless the caller passes `confirmed: true`. |

After the call, the platform refetches what the action invalidates and notifies other blocks on the same topics. Implemented.

#### Event actions (Planned)

An action can emit an event instead of calling a tool. It's how a button in a view, or an agent, starts automation work ("investigate this PR", "draft a fix").

```ts
block.action("investigate", { emits: "investigate_pr" });
```

The caller's `input` becomes the event's payload (JSON, at most 16 KB). The event is namespaced like any emit (`<module>.investigate_pr`). The event is delivered like any other (see [Events and automations](#events-and-automations-planned)), with `cause` set to whoever called the action: `user:<id>` for a click, `agent:<session>` or `automation:<id>/run:<id>` for a tool call. The action resolves immediately with `{ eventId }`; it doesn't wait for automation runs to start.

Use a tool action for a direct, single write (close a PR). Use an event action for work an agent should do: multi-step, judgment calls, or producing something.

### `block.describe(fn: () => string)`

The one line agents see about the block: what it shows right now. Recomputed with `setup`. Implemented.

### `block.status(fn: () => Status | null)` (Planned)

The block's current state, for the canvas and for "what needs me" views. Separate from events: an event says something happened; status says what the block is doing now. The vocabulary follows Rex's Program Status Protocol (OSC 7501):

```ts
type Status = {
  state: "idle" | "working" | "blocked" | "finished" | "failed";
  kind?: string;   // for blocked: "permission", "input", "review"...
  msg?: string;    // one line, shown to people and agents
};

block.status(() => (red.length ? { state: "blocked", kind: "review", msg: `${red.length} PRs failing` } : { state: "idle" }));
```

Recomputed with `setup`. The canvas shows it (spinner, blocked marker) and pushes changes to viewers; agents read it in the block's agent view. Sessions and automation runs report the same shape, so one view can list everything waiting on a person.

### `block.on(query, handler)` (Planned)

Runs `handler(change)` when a query's rows change. `change` is `{ added, updated, removed }`: rows keyed by the query's `key`, computed by the Block DO from its diff. Handlers run in the block's isolate after each reconcile. They can't call tools or reach the network; they can only `emit`. Use them for quick, in-block reactions. Anything that does work is an automation (see [Events and automations](#events-and-automations-planned)).

```ts
block.on(prs, (change) => {
  const red = change.updated.filter((p) => p.ci === "failing");
  if (red.length) block.emit("pr_turned_red", { prs: red.map((p) => ({ repo: p.repo, number: p.number, title: p.title })) });
});
```

### `block.emit(name, payload)` (Planned)

Emits a named event from a `block.on` handler. `name` is lowercase letters, digits and `_`. Events are namespaced by module, like Rex's `<kind>.<event>`: `block.emit("pr_turned_red")` in `ci-board` is delivered as `ci-board.pr_turned_red`. `payload` must be JSON and at most 16 KB; prefer structured fields over free text. The isolate returns emits as data and the Block DO delivers them.

### `ctx.mcp`

Typed references to the tools in the catalog, e.g. `ctx.mcp.github.list_pull_requests`. A reference only names the tool; calling it is the platform's job. Implemented with a fixed mock catalog; Planned: generated from the workspace's MCP gateway connectors.

Tool access: a block may call any tool in the catalog, with its principal's credentials (whoever opened it on the canvas). There is no per-block tool list for now. Writes should be `confirm` actions so a person clicks them. Per-block consent grants are a possible later addition.

## `view(props)`

Runs in a `sandbox="allow-scripts"` iframe on a separate origin with CSP `default-src 'none'; connect-src 'none'`: no network, storage, cookies or parent access. Its only channel is the host's MessagePort.

| Prop | Type | Meaning |
|---|---|---|
| `data` | `Record<string, Row[]>` | Current rows per query. |
| `status` | `Record<string, Status>` | Per query. |
| `errors` | `Record<string, string>` | Per query, when `status` is `error`. |
| `state` | `Record<string, any>` | Block state. |
| `setState(key, value)` | | Writes state; `setup` re-runs. |
| `act(name, input, { confirmed? })` | `Promise` | Runs an action. Resolves with the tool's result, or `{ eventId }` for an event action (Planned). Rejects with the server's error. The SDK attaches a client id, so a double click or retry runs the action once. |
| `events` | `BlockEvent[]` | Planned. The block's recent events, newest first: `{ id, name, cause, at, runs: { automation, runId, status }[] \| null }`. `runs` is `null` until the router reports, and `[]` if no automation handles the event. |
| `refresh()` | | Refetches every query. |

Exports: `Section`, `Stat`, `Badge`, `Table` (themed components); `useState`, `useMemo`, `useEffect`, `useRef`, `useCallback`. A view that throws renders an error in place and reports it to the host. Implemented.

## Events and automations (Planned)

Blocks don't run workflows. Durable, multi-step work belongs to the product's existing automations (a trigger plus a prompt that starts an agent session). Blocks plug into them in three ways: as a trigger source, as something sessions read and change, and as a place runs are shown.

### Delivery path

```
block.on handler (isolate)  →  Block DO  →  Queue  →  trigger router  →  automation session
     returns emits              envelope,     durable,     matches            existing run path
                                debounce, log  retries      <module>.<event>
```

1. After a reconcile, the Block DO calls the isolate with each changed query's `change`. The SDK runs the matching handlers and returns their emits.
2. The Block DO validates each emit, debounces per `(block, event)` (default one per 10 s), appends it to the block's event log, and puts an envelope on a Cloudflare Queue.
3. The queue consumer hands the envelope to the product's trigger router. An automation subscribes to an event name, `<module>.<event>`, optionally narrowed to one block (`ci-board.pr_turned_red` on block `ci-board`, or from any block of that module). The router finds the matching automations and starts their sessions with the prompt plus the envelope.

### Envelope

```json
{
  "id": "evt_01J…",
  "workspace": "workspace",
  "block": "ci-board",
  "version": "ci-board@3a6f080",
  "event": "ci-board.pr_turned_red",
  "payload": { "prs": [{ "repo": "inspect/web", "number": 15, "title": "Fix link group colors" }] },
  "cause": { "actor": "webhook:github" },
  "at": 1793600000000
}
```

`cause.actor` is whoever caused the change the event came from: `webhook:<source>`, `user:<id>`, `agent:<session>` or `automation:<automation id>/run:<run id>`.

### Guarantees and guards

- **At-least-once.** The router deduplicates by `id`. Order across events is not guaranteed; sessions should re-read the block (`block_read`) rather than rely on order.
- **Loop guard.** A session's Mason tool calls (`block_set_state`, `block_action`, canvas ops) carry its run id; the Block DO records it as the cause of the next reconcile, and events from that reconcile inherit it. The router doesn't start an automation from its own runs' effects, and stops chains of automation-caused events after 3 hops.
- **Untrusted content.** Payload text can come from upstream data (PR titles, messages). Sessions receive the envelope marked as data, not instructions.

### Run feedback

When the trigger router starts runs for an event, it reports them back to the Block DO (`POST /api/blocks/:id/events/:eventId/runs` with `{ runs: [{ automation, runId }] }`, an internal endpoint). The Block DO adds them to the event log and pushes an `event` message to viewers, so a view can show "Investigation started", link to the session, or say "No automation handles this yet" when `runs` is empty. Run status updates arrive the same way.

### Guards for event actions

- **One emit per action call.** The client id deduplicates double clicks and retries.
- **Rate limit** per user, block and event (default 10 per minute). Over the limit, the action is refused with an error the view can show.
- **Validation.** The input is user-supplied: checked as JSON with a size cap, and delivered to sessions marked as data.

### Sessions and blocks

Automation sessions have the same tools as regular sessions, plus the Mason block and canvas tools ([canvas-api.md](canvas-api.md#mcp-tools-for-agents-planned)): read a block, set its state, run its actions, open blocks. A session can also edit block code through the workspace repo like any agent.

### On the canvas

An automation block shows one automation: its trigger, recent runs with status, and a link to open a run as a session block. Closing it never stops the automation.

## Tool catalog (prototype)

| Tool | Args | Rows | Push |
|---|---|---|---|
| `github.list_pull_requests` | `{ repo, state? }` | `PullRequest` | webhook topic `github:repo:<repo>:pulls` |
| `github.close_pull_request` | `{ repo, number }` | `{ ok, closedBy }` | emits the same topic |
| `datadog.query_metrics` | `{ query }` | `{ id, value, at }` | none (poll) |

## Publishing

### Remote

```
git clone http://agent:<token>@<host>/git/<workspace>.git
```

Smart-HTTP git through the platform's proxy. Basic auth; the password is the credential. Without it the remote answers `401` with `WWW-Authenticate: Basic`. Implemented with a shared dev token. Planned: per-session credentials scoped to a workspace, a principal and allowed branches, installed through the sandbox's credential helper; agents never hold an Artifacts token.

### What a push does

A push that moves `main`:

1. Lists the paths changed between the old and new head.
2. For each `blocks/*.tsx`: reads it at the new commit, checks it (below), compiles it to a server bundle and a client bundle, stores both by sha256, evaluates `setup` once in a sandbox to read the manifest, and records the version as the module's head.
3. Tells the canvas, which moves every block following that module's head to the new version in place.
4. Returns, with the results in the push output.

The push doesn't return until this is done. Implemented. Planned: pushes to other branches publish branch versions to a preview canvas; merging into `main` publishes.

### Checks

A module is not published, and its blocks keep their previous version, if:

- the source looks like it contains a token (`ghp_…`, `xox…`, `sk-…`);
- it imports anything but `@mason/sdk` and `@mason/sdk/jsx-runtime`, or uses dynamic `import()`;
- it doesn't compile;
- its default export isn't a `Block.define` with an `id`.

Implemented.

### Push output

The platform adds lines to git's progress channel, which git prints as `remote:`:

```
remote: mason: blocks/<module>.tsx → <version>; reloaded <block ids or "no blocks">[; pinned, not moved: <block ids>]
remote: mason: blocks/<module>.tsx not published: <reason> (blocks stay on their previous version)
remote: mason: blocks/<module>.tsx deleted; blocks using <module> keep their last version
```

Implemented.

### Versions in place

When a block moves to a new version: state and cached rows are kept; queries whose tool and args are unchanged are not refetched; queries the new code no longer declares are dropped; open views reload with the new client bundle. Implemented.

## Agents without a sandbox (Planned)

MCP tools over the same repo, committing on the agent's behalf, with Claude Code–style semantics:

| Tool | Input | Result |
|---|---|---|
| `blocks_read_file` | `{ path, ref? }` | file text |
| `blocks_list_files` | `{ ref? }` | paths |
| `blocks_edit_file` | `{ path, old_string, new_string, branch? }` | new commit, then the same publish lines as a push |
| `blocks_write_file` | `{ path, content, branch? }` | same |

Both paths publish through the same pipeline, keyed by commit.

## Limits

| Limit | Value |
|---|---|
| Push size | 64 MiB (Artifacts) |
| Module source | Practically small; one file per module |
| Re-evaluation passes per change | 5 (dependent queries) |
| Poll interval | Planned: a minimum enforced per block |
