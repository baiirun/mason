# mason

A prototype panel multiplexer for React: spaces, splits, tabs, drag-to-rearrange and keyboard commands, like tmux / i3 / Rex, for arbitrary React components ("blocks"). The layout is **server-owned** and every change is **optimistic**.

```
npm install
npm run dev          # server on :4317, web on http://localhost:5317
```

Open http://localhost:5317 in two windows to watch them stay in sync.

## Try this

- **Drag a tab** onto another block's center (adds it as a tab), onto an edge (splits), onto the very edge of the space (splits the whole space), into a tab bar (reorders), or onto a space tab at the top (moves it to that space).
- Click the button in **Preview** a few times, then drag it around. The count and "mounted at" time stay, because blocks never remount.
- **Link groups**: the coloured dot on a tab is its link group. Diffs, Preview and Child sessions with no fixed session follow whichever session in their group last had focus. Click the dot to cycle A, B, C, or none.
- In a session, the **Diffs / Children / Preview** buttons call `block.open(...)` to open a related block beside it, or focus it if it's already open.
- Send a message in a session: the fake agent streams a reply, edits a file (Diffs updates), and sometimes spawns a child session. See "Agents" below for the release-notes demo.
- **Agent-driven layout**, from a terminal while the app is open:
  ```
  npm run mux -- ls
  npm run mux -- open inspect.preview --below inspect.session.children --link A
  npm run mux -- open inspect.session --state '{"sessionId":"s-docs"}' --right-of inspect.doc
  npm run mux -- close inspect.preview
  npm run mux -- reset
  ```
- **Latency**: `LATENCY=800 npm run dev -w @mason/server` (with `npm run dev -w @mason/web` alongside) delays every server message by 800ms. The UI still updates instantly; the status bar shows pending ops until the server confirms.

## Agents and the blocks around them

An agent lives in a block (a session). Each turn it gets a short **manifest** of the blocks around it, composed from each block kind's server-side `describe()`, plus **tools** to read and act on them:

```
$ npm run mux -- context session:s-docs
You are Session “Docs pass” [block-…], in space “Write”.
Blocks around you (3):
- [block-…] Doc “Release notes”, left of you. 1 non-empty lines; … Tools: doc_append, doc_replace, doc_edit.
- [block-…] Diffs of “Refactor auth flow”, below you. src/auth/useAuthSession.ts (+42 −0), … Tools: diffs_open_file.
- [block-…] Child sessions of “Refactor auth flow”, below you. Token refresh worker (idle, 1 files), …
Call read_block(blockId) for a block's full content.
```

- **Scope**: the agent's link group if it has one, otherwise its whole space. The ◉ toggle on a tab hides a block from agents.
- **Tools**: layout tools for every agent (`list_blocks`, `read_block`, `open_block`, `close_block`) plus kind tools for kinds in scope (`doc_append`, `session_send`, `diffs_open_file`...). Each kind tool takes a `blockId`, limited to blocks in scope. Each has a permission (`read`, `write`, `confirm`); `confirm` isn't enforced yet.
- **Try it**: in the *Write* space, tell the Docs pass session “write the release notes”. It reads the diffs and child sessions next to it and writes into the doc on the left, live. Expand “Context from N blocks” in the transcript to see exactly what it was given. Ask “what can you see?” after hiding a block.
- **A real agent**: the server is an MCP server. Point Claude Code at a block and it gets the same scoped tools, and a `mason://context` resource with the manifest. The tool list updates (`tools/list_changed`) when the layout changes:
  ```
  claude mcp add --transport http mason "http://localhost:4317/mcp?block=session:s-docs"
  ```
- From a terminal: `npm run mux -- call session:s-docs doc_append '{"blockId":"<id from context>","text":"- hi\n"}'`

Server-side kinds live in `apps/server/src/blocks`, the scoping/manifest/tool plumbing in `apps/server/src/agent/context.ts`, MCP in `apps/server/src/mcp.ts`. The scripted agent (`agent/fakeAgent.ts`) only uses `manifest()` and `callTool()`, the same surface a real agent gets.

## Keys

Leader is `ctrl+b` (tmux style), then:

| key | action | key | action |
|---|---|---|---|
| `%` / `"` | split right / down (opens a launcher) | `h j k l` | focus left/down/up/right |
| `t` | new tab | `H J K L` | move block into the stack in that direction |
| `x` | close block | `z` | zoom |
| `c` | new space | `1`–`9`, `n`, `p` | go to space |
| `,` | rename space | `&` | close space |
| `!` | move block to a new space | `g` | cycle link group |
| `[` `]` | prev/next tab | `r` | resize mode (`hjkl`, `esc` to leave) |
| `:` | command palette | `o` | focus next block |

Direct chords (i3 style): `alt+hjkl` focus, `alt+shift+hjkl` move, `alt+1..9` spaces, `alt+enter` split, `alt+w` close, `alt+f` zoom, `cmd/ctrl+k` palette.

## Layout

```
packages/core     headless TypeScript, no DOM
  types.ts        Workspace → Space → layout tree (Split | Stack of block ids) + block records
  tree.ts         n-ary split tree ops, normalization (collapse/merge same-direction splits)
  apply.ts        applyOp(): the one pure reducer the server and every client run
  sync.ts         SyncClient (optimistic: view = pending ops replayed on confirmed state) and SyncServer
  geometry.ts     directional focus, drop zones
  template.ts     layouts as code: row([0.3, 0.7], block("doc"), col(block("session"), block("preview")))
packages/react
  mux.ts          Mux: sync client + per-client view state (focus, zoom, drag) + portal elements
  context.tsx     MuxProvider, useBlock(), useLinkValue/useLinkPublish, useWorkspace, useView
  layout.tsx      split/stack/tab rendering, splitters, Slot
  chrome.tsx      BlockHost (portals), space bar, launcher, palette, status bar, keyboard
  dnd.ts          pointer-event drag and drop
  commands.ts     command registry + Rex-style keymap ("ctrl+b>x", "resize/h")
apps/server
  workspace.ts    the server-owned layout (SyncServer), persisted to data/workspace.json
  server.ts       WebSocket /ws (layout ops), /data (inspect data), /mcp, HTTP /api/*
  blocks/         server half of each block kind: describe(), read(), tools
  agent/          scope + manifest + tools per agent block; scripted fake agent
  inspect/        stand-in inspect backend (sessions, docs, diffs), persisted to data/inspect.json
  cli.ts          npm run mux -- ...
apps/web          React half of each block kind, on the stand-in backend
```

### How it fits together

- **Shared vs per-client.** The workspace (spaces, layout tree, block kinds and state, link groups) lives on the server. Focus, zoom, active space, drag state, titles and link values are per client.
- **Ops, not trees.** Every change is an `Op` (`openBlock`, `moveBlock`, `resize`...) against stable ids. Ids are made on the client, so a new split renders and can be split again before the server confirms it.
- **Optimistic.** `SyncClient.dispatch` applies the op locally and sends it. Server broadcasts advance the confirmed state and pending ops are replayed on top. A rejected op is dropped with a toast. On reconnect the server says which ops it already has, so nothing is applied twice.
- **No remounts.** `BlockHost` renders every block once into its own long-lived DOM element via a portal. Layout `Slot`s just move that element around, so React state and subscriptions survive drags, splits, tab switches and space switches.
- **Blocks hold references.** Block state is things like `{ sessionId }`. Data comes from the app's own hooks (here `mockApi.ts`; in inspect, the query cache).

### Adding a block kind

```tsx
defineBlock({
  kind: "inspect.logs",
  name: "Logs",
  icon: "≡",
  component: ({ state }) => {
    const block = useBlock<{ sessionId?: string }>();
    const linked = useLinkValue<string>("session");
    const logs = useSessionLogs(state.sessionId ?? linked);
    return <LogView logs={logs} onOpenFile={(p) => block.open({ kind: "inspect.file", state: { path: p } }, { placement: "tab" })} />;
  },
  launch: () => [{ label: "follows linked session", state: {} }],
});
```

## Not done yet

Floating layer and pop-out windows, undo/redo, multi-user auth and per-user/per-project workspaces, layout templates in the UI, tests for the React layer, mobile/touch tuning, accessibility of splitters and tabs. The fake agent is scripted; a real one would connect over MCP.
