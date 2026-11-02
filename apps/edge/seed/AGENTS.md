# Blocks workspace

This repo is the code for the blocks on a Mason canvas. Edit it like any other code: change files, run `npx tsc -p .`, commit, `git push`. A push publishes immediately, and the push output tells you what happened:

```
remote: mason: blocks/oncall-desk.tsx → oncall-desk@ad4f41e; reloaded api-desk, web-desk
remote: mason: blocks/foo.tsx not published: import "node:fs" is not allowed (...) (blocks stay on their previous version)
```

Always read the `remote: mason:` lines after pushing. If a module wasn't published, fix it and push again; its blocks keep running the last good version meanwhile.

## Layout

- `blocks/<module>.tsx`: one module per file. The filename is the module id.
- `types/mason-sdk.d.ts`: types for `@mason/sdk`, the only import allowed.
- `canvas.json`: a starting layout, applied once to an empty canvas. Editing it later does nothing; use the canvas API below.

Code and canvas are separate. A push changes what a module does; every block following that module's head picks it up in place (state kept), and pinned blocks don't. Which blocks exist, their props and where they sit are changed through the canvas API, never by commits.

## A block module

```tsx
import { Block, Section, Table } from "@mason/sdk";

export default Block.define<{ repo: string }>({
  id: "my-module",                       // match the filename

  // Runs on the server, in a sandbox with no network. Declare data; don't fetch it.
  setup(block, ctx) {
    const prs = block.query("prs", ctx.mcp.github.list_pull_requests, () => ({ repo: block.props.repo, state: "open" }));
    block.describe(() => `${prs.value?.length ?? 0} open PRs`); // what agents see about this block
  },

  // Runs in the browser, in a sandboxed iframe with no network. Render the data.
  view({ data }) {
    return <Section title="Open PRs"><Table rows={data.prs ?? []} columns={[{ label: "Title", render: (p) => p.title }]} /></Section>;
  },
});
```

- `block.query(name, tool, () => args, { refresh?, key? })`: a live query. The args function re-runs when props, state or other queries change; return `null` to wait. GitHub queries update by webhook; use `refresh: "30s"` only for sources that can't push (Datadog). Rows are keyed by `id` unless you pass `key`.
- `block.state(key, initial)`: state the view can change with `setState(key, value)`. It survives code changes.
- `block.action(name, tool, { invalidates: [query], permission: "confirm" })`: a write the view triggers with `act(name, input, { confirmed: true })`. Invalidated queries refetch before `act` resolves.
- `block.describe(() => string)`: one line about what the block shows right now.
- The view gets `{ data, status, errors, state, setState, act, refresh }`, where `data.<query>` is the rows. UI pieces: `Section`, `Stat`, `Badge`, `Table`; hooks: `useState`, `useMemo`, `useEffect`, `useRef`, `useCallback`.

## Tools

| Tool | Args | Rows |
|---|---|---|
| `github.list_pull_requests` | `{ repo, state? }` | `{ id, number, repo, title, author, reviewers: string[], ci: "passing" \| "failing" \| "pending", state, updatedAt }` |
| `github.close_pull_request` | `{ repo, number }` | `{ ok, closedBy }` |
| `datadog.query_metrics` | `{ query }` | `[{ id: "p95", value, at }]` (no push; poll it) |

Repos: `inspect/web`, `inspect/api`.

## The canvas

The canvas is server-owned. Read it and change it with ops; people dragging blocks in the UI use the same ops.

```
curl -s localhost:8787/api/canvas                    # every block: id, module, version, props, rect
curl -s localhost:8787/api/modules                   # published modules and their current versions
curl -s -X POST localhost:8787/api/canvas/ops -d '{"type":"open","module":"ci-board","near":"web-desk"}'
```

| Op | Fields |
|---|---|
| `open` | `module`, optional `id`, `props`, `near` (place beside a block), `rect`, `pin` (stay on the current version) |
| `move` | `id`, `x`, `y` |
| `resize` | `id`, `w`, `h` |
| `setProps` | `id`, `props` |
| `close` | `id` |

A module has to be pushed before you can open a block of it.

## Seeing a block at runtime

```
curl -s localhost:8787/api/blocks/web-desk
```

returns the block's describe line, version and commit, and each query's tool, args, status, row count and freshness. Open http://localhost:8787 to see the canvas.

## Rules

- No imports other than `@mason/sdk`. No `fetch`, storage or DOM access outside your own view; both halves are sandboxed and it will fail.
- Never put tokens or secrets in code; the push is refused.
- `blocks/escape-attempts.tsx` deliberately breaks these rules to show the sandbox. Don't copy it.
