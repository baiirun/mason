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
  tools: ["github.list_pull_requests"],
  setup(block, ctx) { ... },
  view(props) { ... },
});
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | yes | Module id. Should match the filename. |
| `tools` | string[] | yes | Every tool the block may call, as `server.tool`. Calls to anything else are refused by the gateway. Planned: adding a tool to an existing module needs approval at merge. |
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

### `block.describe(fn: () => string)`

The one line agents see about the block: what it shows right now. Recomputed with `setup`. Implemented.

### `ctx.mcp`

Typed references to the tools in the catalog, e.g. `ctx.mcp.github.list_pull_requests`. A reference only names the tool; calling it is the platform's job. Implemented with a fixed mock catalog; Planned: generated from the workspace's MCP gateway connectors.

## `view(props)`

Runs in a `sandbox="allow-scripts"` iframe on a separate origin with CSP `default-src 'none'; connect-src 'none'`: no network, storage, cookies or parent access. Its only channel is the host's MessagePort.

| Prop | Type | Meaning |
|---|---|---|
| `data` | `Record<string, Row[]>` | Current rows per query. |
| `status` | `Record<string, Status>` | Per query. |
| `errors` | `Record<string, string>` | Per query, when `status` is `error`. |
| `state` | `Record<string, any>` | Block state. |
| `setState(key, value)` | | Writes state; `setup` re-runs. |
| `act(name, input, { confirmed? })` | `Promise` | Runs an action. Rejects with the server's error. |
| `refresh()` | | Refetches every query. |

Exports: `Section`, `Stat`, `Badge`, `Table` (themed components); `useState`, `useMemo`, `useEffect`, `useRef`, `useCallback`. A view that throws renders an error in place and reports it to the host. Implemented.

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

The push doesn't return until this is done. Implemented. Planned: pushes to other branches publish branch versions to a preview canvas; merging into `main` publishes, and waits for approval if a module's `tools` grew.

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
