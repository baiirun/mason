# Panel multiplexer for inspect.com: design brainstorm

A React package that lets users build **spaces** (workspaces) out of arbitrary **panes** (docs, coding sessions, previews, terminals, diffs...), tile them like tmux/i3, drag them around like VS Code/dockview, and drive it all from the keyboard.

Working name below: `@inspect/mux`.

---

## 1. Layout model

**Recommendation: an n-ary split tree per space, with tab stacks at the leaves, plus a floating layer.** Not a CSS grid.

```
Space
├── root: Node
│     Split { dir: "row" | "col", children: Node[], sizes: number[] }
│     Stack { panes: PaneId[], active: PaneId }        // a leaf: 1..n tabs
├── floating: { paneId, rect, z }[]                     // optional layer
├── zoomed?: PaneId                                     // tmux `prefix z`
└── focus: PaneId
```

Why a tree:
- Every tiling WM and multiplexer that feels good uses one (tmux, i3/sway, Zellij, VS Code's editor grid, react-mosaic). Splitting a pane, closing it, and having siblings reflow are all local tree operations.
- n-ary (i3/VS Code) rather than binary (react-mosaic). Binary trees make "three equal columns" awkward and resizing feels wrong. Normalize on every op: collapse a split with one child, merge a split into a parent with the same direction.
- A grid can be produced *from* the tree (layout presets such as "even-horizontal", "main-vertical" à la tmux are just tree builders).

Tabs: every leaf is a stack, a single pane is just a stack of one. This makes "drop in the center = add as tab" uniform. i3 goes further and lets *any* container be tabbed/stacked; probably not worth it at first.

Floating: a separate layer above the tree (Zellij and dockview both do this). Keep it optional for v1; it doubles the drag/drop and focus cases.

Zoom/maximize: a view flag, not a tree change, so un-zooming restores exactly.

## 2. Architecture: headless core + React bindings

```
@inspect/mux-core    pure TS: model, reducer ops, geometry, commands, serialization (no DOM)
@inspect/mux-react   <MuxProvider>, <Space>, <PaneSlot>, hooks, DnD, keybindings
```

The core is a reducer over immutable state:
`split(paneId, dir, newPane)`, `close`, `move(paneId, target)`, `resize(splitId, sizes)`, `swap`, `rotate`, `equalize`, `zoom`, `focusDir("left")`, `moveToSpace`, `float/dock`.
Benefits: undo/redo for free, trivially testable, easy to sync to a server, and commands from the keyboard, palette, drag-and-drop, and an agent all go through the same ops. That last one matters for inspect: **an agent session could open a preview next to itself** by dispatching `split`.

## 3. Pane registry and content API

```ts
defineMuxPane({
  kind: "session",
  title: (state) => state.name,
  icon: SessionIcon,
  component: SessionPane,
  defaultState: () => ({ sessionId: null }),
  // persistence
  version: 2,
  migrate: (old, fromVersion) => ...,
  // behaviour
  commands: { "session.interrupt": ... },
  singleton?: (state) => state.sessionId,   // re-focus instead of opening a duplicate
});

function SessionPane() {
  const pane = usePane();          // { id, state, setState, setTitle, close, split, focus, isFocused, isVisible }
  const link = usePaneLink();      // see §4
  ...
}
```

Rules worth fixing early:
- **Pane state must be serializable** (ids, paths, scroll position), never live objects. Live things (websocket to a session, editor instance) are resolved at runtime from that state.
- Unknown `kind` on load renders a placeholder ("This pane type isn't available") rather than crashing, so layouts survive feature flags and version skew.
- `isVisible` lets hidden tabs/spaces pause expensive work (previews, polling).

## 4. Per-pane context and linking

Two layers:
1. **Pane-local state**: owned by the pane, persisted (§7).
2. **Runtime context**: host-provided services (session client, file system, auth) via normal React context above `<MuxProvider>`; panes look things up by the ids in their state.

The interesting one for "a doc next to sessions next to previews" is **linking** (golden-layout's event hub, Bloomberg-terminal colour groups): panes join a channel and publish/subscribe to a shared selection.
- A preview linked to session A follows the URL/port session A is serving.
- A diff pane linked to a session shows that session's latest changes.
- A doc pane linked to the space shows the space's spec.

API sketch: `usePaneLink<T>("session")` returns `[value, publish]`; the user sets links via a pane header chip or by dropping one pane's "link handle" onto another. Probably the feature that makes this feel native to a coding harness rather than a generic tiler.

## 5. Rendering and remounts

Assumption (from Byron): panes are **not iframes**. We own both the data and the components, all in the same React tree.

The one remaining problem: moving a pane in the tree changes its React parent, which **remounts it** (lost local state, effects re-run, sockets re-opened).

Two complementary answers:
1. **Make remounts cheap.** Since we control the data, keep anything that matters (session stream, doc contents, preview state, scroll/selection if we care) in an external store keyed by pane id or entity id (Zustand/Jotai/TanStack Query or our own), not in component state. A remount then just re-subscribes.
2. **Avoid remounts anyway with portals.** Render every pane once in a stable, flat list keyed by pane id, and `createPortal` each into a long-lived DOM node owned by the mux. The tree renders empty slots; on layout change we `appendChild` that node into the new slot. React sees no parent change, so no remount. Moving plain DOM is safe (it was only iframes that reload). Small caveats: focus is lost and scroll can reset on move, so save and restore both.

Hidden tabs/spaces: keep mounted with `display:none` or unmount, per kind (`keepAlive: true | false`). With (1) in place, unmounting off-screen panes is a cheap way to save memory.

This gets much simpler without iframes and is no longer the main risk; DnD and keyboard UX are.

## 6. Drag and drop

- Drop targets per stack: **center** (add as tab), **4 edges** (split that direction), plus **root edges** (split the whole space), **tab bar** (reorder), **space tabs** (hover to switch, drop to move to space), and "drop outside" to float.
- Show a translucent preview of the resulting rectangle, not just a highlight (VS Code and dockview both do this, it's what makes it feel precise).
- Use **pointer events, not HTML5 drag-and-drop** (better control of the drag preview, works with touch). With no iframes we don't need an event shield; a library like dnd-kit or pragmatic-drag-and-drop is an option.
- Resizing: splitter handles with keyboard support; `react-resizable-panels` or `allotment` are fine references, but resizing is simple enough to own given the tree.
- Drag sources from outside the mux too: drag a file from the file tree to open it as a pane; drag a session from the sidebar.

## 7. Keyboard-driven commands

- **Command registry** (core) + **keymap** (react). Every op is a named command (`pane.splitRight`, `focus.left`, `space.goto.3`, `pane.zoom`), so keybindings, command palette, menus and agents share one surface.
- Support both styles:
  - **Prefix/leader mode** (tmux `Ctrl-b`, Zellij modes): press a leader, then `%` / `"` / `h j k l` / `z`. Avoids fighting the browser and editors for chords.
  - **Direct chords** (i3 `mod+hjkl`, VS Code `Cmd+\`) for the common few.
- **Directional focus by geometry** (find the nearest pane to the left of the focused rect), not tree order, which is how i3 and tmux feel right.
- Browser realities: `Cmd-W/T/N`, `Cmd-1..9` in some browsers can't be captured. Focus inside a Monaco/CodeMirror editor swallows keys; register the leader key in the editor's keymap so it hands off to the mux. (No iframes means no `postMessage` bridge.)
- Optional mode indicator (Zellij-style status line) when leader is active.

## 8. Spaces

- A space = name + tree + floating layer + focus. `mod+1..9` to switch, `move pane to space N`.
- **Templates/presets**: "Review" (diff + session + preview), "Write" (doc + session). Saving the current space as a template is cheap once serialization exists.
- **Scratchpad** (i3): a hidden pool for panes you summon with a key (e.g. a quick terminal or notes).
- Later: **pop out** a space or pane to a real browser window (`window.open` + portal, as dockview and golden-layout do). Useful on multi-monitor setups; complicates focus and keyboard.

## 9. Persistence and serialization

```json
{
  "schema": 1,
  "spaces": [{ "id": "s1", "name": "Review", "root": { "split": "row", "sizes": [0.4, 0.6], "children": [...] } }],
  "panes": { "p1": { "kind": "session", "v": 2, "state": { "sessionId": "..." } } },
  "activeSpace": "s1"
}
```
- Keep **layout** and **pane state** separate; layout is small and changes often, pane state is per kind and versioned with its own `migrate`.
- Top-level `schema` with migrations.
- Store: localStorage for instant restore, synced to the server per user (and per project?) with debounced writes.
- Shareable layouts: a template is a layout with pane state stripped to "recipes" (e.g. "a preview linked to the first session") rather than concrete ids.

## 10. Prior art

| | Model | Worth stealing | Notes |
|---|---|---|---|
| **Rex** (Superlogical, beta) | server → sessions → windows (tabs) → blocks; binary split tree with ratios + floating layers | blocks typed by `flavor` (plugin-style, not just terminals); layouts declared as code; server owns state, clients attach; dotted actions shared by keys, palette and CLI (`--json`); key sequences + exclusive modes; stable never-reused ids, targets by id/label/position | Byron's reference; see §13 |
| **tmux** | sessions → windows → panes (tree) | prefix key, zoom, layout presets, `break-pane`/`join-pane` | the mental model users already know |
| **i3 / sway** | containers tree, per-container split/tabbed/stacked | workspaces, scratchpad, geometric focus, `mod+hjkl` | best keyboard model |
| **Zellij** | tabs → panes, floating layer, KDL layouts | modes with status bar, floating panes, plugin panes, layout files | most modern multiplexer UX |
| **VS Code** | editor-group grid + view containers/panels | drop-zone previews, serialization, "always render" webviews | the mouse UX to match |
| **dockview** | grid of groups (tabs), floating, popouts | zero-dep TS core + React bindings, overlay/always-render modes, serialization | **closest existing lib**; could prototype on it |
| **FlexLayout** | JSON model: rows/tabsets/borders | border docks, JSON-first model | React-only, more opinionated |
| **golden-layout** | rows/cols/stacks | linking via event hub, popout windows | older, less maintained |
| **react-mosaic** | binary split tree | minimal tree ops | binary tree limitation |
| **Lumino / JupyterLab** | DockPanel | command registry + keymap + palette as one system | good reference for §7 |
| **react-resizable-panels / allotment** | splitter primitives | resize handles, a11y | building blocks only |

## 11. Build vs. adopt

- **Adopt dockview**: fastest path to drag/drop, tabs, floating, popouts and iframe-safe rendering. Spaces, linking and a tmux/i3 keyboard layer would be added on top. Without iframes its main rendering advantage matters less. Risk: its model is mouse/docking-first, so auto-tiling and geometric commands may fight it.
- **Own the core**: the model and reducer are maybe a week of work; rendering (§5) and DnD are the real cost. Gives you keyboard-first semantics, agent-driven ops and linking as first-class concepts.
- Suggested path (updated): with no iframes, leaning toward **owning the core**. Spike it directly: tree reducer + portal rendering + edge/center drop zones + leader-key focus, in inspect, with 3 pane kinds (doc, session, preview). Look at dockview's source for DnD details.

## 13. What to take from Rex

Source: superlogical.com/rex/docs (installation, config, keyboard-shortcuts, key-sequences, key-modes, actions, cli, server-modes, lua reference).

- **Vocabulary.** Rex uses session → window → block. "Block" + `flavor` (`com.superlogical.terminal`) maps directly to our pane `kind`. We could adopt similar naming: space → window/tab → block, with reverse-DNS kinds so third parties can add block types.
- **Server-owned layout.** In Rex the server keeps sessions alive and clients just attach. For inspect, that suggests layout state lives on the backend (not only localStorage): several browser tabs or devices can attach to the same space, and an agent can rearrange it without a browser open. The headless core (§2) runs on both sides; the server is authoritative.
- **Layouts as code.** `rex.layout.horizontal(ratio, a, b)` / `vertical` / `block{flavor, options}`. Our templates (§8) could be a TS builder (`h(0.4, block("doc"), v(0.5, block("session"), block("preview")))`) that compiles to the JSON in §9.
- **One action surface.** Dotted built-in actions (`pane.split`, `pane.zoom`, `session.switch`), user-defined actions via `rex.action{name, title, run}`, all runnable from a key, the palette, or the CLI (`rex do`). Same as our command registry, and it argues for exposing it as an API/CLI so agents and scripts can drive layouts.
- **Keyboard model.** No single prefix; instead key **sequences** (`ctrl+b>c`) and **modes** as named key tables (`resize` mode, `exclusive` to swallow unbound keys, Escape exits). Precedence: client defaults < config < in-app shortcuts. Worth copying wholesale.
- **Targeting.** Stable ids that are never reused (`block:01a1...`), plus optional labels, resolved in order id → label → position → short id. Good for commands like "focus block `preview`".
- **Where we'd differ.** Rex uses binary splits with a ratio; I'd still go n-ary (§1) for even 3-way splits, though binary is simpler and Rex shows it's workable. Rex places blocks explicitly (no auto-tiling found), which suggests explicit placement + good defaults is fine for v1. No layout save/restore format was found in the docs, so persistence (§9) is ours to design.

## 12. Open questions for Byron

1. ~~"Rex"~~: answered, Superlogical's Rex (see §13).
1b. ~~Server-owned spaces~~: decided, the server (see §14).
2. **Tiling vs. docking**: should new panes auto-place (tmux/i3: a split happens, no layout decisions) or be placed by the user (VS Code/dockview)? Or both, with auto-tile by default?
3. **Floating panes and pop-out windows**: in v1 or later?
4. **Scope of spaces**: per user, per project/repo, or shareable with a team?
5. **Audience**: internal to inspect, or a public open-source package? (Affects how general the registry and styling API need to be.)
6. **Agents as layout drivers**: should sessions be able to open/arrange panes themselves (e.g. "open the preview next to me")?
7. **Pane types for v1**: doc, session, preview... what else (terminal, diff, file tree, logs)?

## 14. Server-owned spaces (decided)

Byron: spaces live on the server, Rex-style.

- **Authoritative server, op log.** Clients send intent ops (`split(blockId, "right", {kind})`, `move`, `resize`) against stable ids, never whole trees. The server applies them with the same headless core (§2), assigns a sequence number, and broadcasts to every attached client. Agents and a CLI/API send the same ops.
- **Optimistic clients (hard requirement from Byron).** No layout interaction ever waits on a round trip. A client applies its op locally right away, then rebases its pending ops when the server's sequence arrives (the Replicache/LiveStore pattern). Ops referring to a block that was closed meanwhile are dropped. If the server rejects an op, the client rolls back to the server state plus the remaining pending ops, with a small toast rather than a jarring jump. New blocks get client-generated ids (UUIDv7/ULID) so a split can render and be referenced before the server acks it.
- **Shared vs per-client state.** Layout tree, block kinds and block state are shared. Focus, zoom, active space, and in-progress drags/resizes are per client (Rex also tracks clients separately), so two tabs on one space don't fight over focus. A resize drag stays local and sends one op on pointerup.
- **Thin block state.** Most real data (sessions, docs, previews) already lives on the inspect backend; block state is mostly references (`sessionId`, `docId`) plus view details. This keeps the layout doc small.
- **Lifecycle.** Spaces persist when no client is attached. Closing a block removes it from the layout but doesn't kill the session it points to (unlike a terminal multiplexer), unless the kind says otherwise.
- **Offline / first paint.** Cache the last snapshot in localStorage for instant render, then reconcile with the server.

## 15. Rendering React components in blocks (worked example)

A block is just a registered React component plus a small serializable state. The mux never knows about sessions or diffs; components fetch their own data with inspect's existing hooks.

```tsx
// 1. Register block kinds once, at app start
const registry = createBlockRegistry([
  defineBlock({
    kind: "inspect.session",
    state: z.object({ sessionId: z.string() }),     // serializable, stored on the server
    title: ({ sessionId }) => useSession(sessionId).data?.name ?? "Session",
    component: SessionBlock,
  }),
  defineBlock({
    kind: "inspect.session.diffs",
    state: z.object({ sessionId: z.string().optional() }), // optional: can follow a link instead
    component: DiffsBlock,
  }),
  defineBlock({
    kind: "inspect.session.children",
    state: z.object({ sessionId: z.string() }),
    component: ChildSessionsBlock,
  }),
]);

// 2. Mount the mux inside the app's normal providers
<QueryClientProvider client={qc}>
  <InspectApiProvider>
    <MuxProvider registry={registry} spaceId={spaceId}>
      <Space />
    </MuxProvider>
  </InspectApiProvider>
</QueryClientProvider>

// 3. A block is an ordinary component
function SessionBlock({ state }: BlockProps<{ sessionId: string }>) {
  const { data } = useSession(state.sessionId);   // existing inspect hook; cache survives remounts
  const block = useBlock();                         // id, setState, setTitle, close, open, isFocused, isVisible
  useLinkPublish("session", state.sessionId);       // linked blocks follow this session
  return <SessionView session={data} paused={!block.isVisible} />;
}

function DiffsBlock({ state }: BlockProps<{ sessionId?: string }>) {
  const linked = useLinkValue<string>("session");  // follow the linked session if no explicit one
  const sessionId = state.sessionId ?? linked;
  const { data: diffs } = useSessionDiffs(sessionId);
  const block = useBlock();
  return (
    <DiffList
      diffs={diffs}
      onOpen={(d) => block.open({ kind: "inspect.diff", state: { sessionId, path: d.path } }, { placement: "tab" })}
    />
  );
}

function ChildSessionsBlock({ state }: BlockProps<{ sessionId: string }>) {
  const { data: children } = useChildSessions(state.sessionId);
  const block = useBlock();
  return (
    <SessionList
      sessions={children}
      // open beside this block; reuse if that session is already open somewhere
      onSelect={(s) => block.open({ kind: "inspect.session", state: { sessionId: s.id } }, { placement: "right", reuse: true })}
    />
  );
}
```

Key points:
- **Block state holds references, not data** (`sessionId`, not the session). Data comes from the query cache, so remounts are cheap and several blocks showing the same session share one subscription.
- **Any app context works** because blocks render inside the app's providers (portals keep React context).
- **`block.open(...)`** dispatches an optimistic `split`/`addTab` op (§14) relative to the calling block. Agents use the same op server-side.
- **Links** let generic blocks (diffs, preview, logs) follow whichever session they're linked to instead of a fixed id.
- **Visibility** (`isVisible`) lets heavy blocks pause streams when hidden in a background tab or space.
- **Header extras**: a kind can also export `toolbar` and `commands` (e.g. `session.interrupt`) that appear in the block header and command palette when it's focused.

## 16. Composing agent context from blocks (prototyped)

Each block kind has a server half `{ kind, describe(block, ws), read(block, ws), tools[] }` next to its React half `{ kind, component }`.
- **Scope**: the agent's link group, else its whole space; hidden blocks excluded.
- **Manifest every turn**: one line per block (title, position relative to the agent, summary, tools). Full content via `read_block`, so many blocks don't flood the prompt.
- **Tools**: layout tools (`list_blocks`, `read_block`, `open_block`, `close_block`) + kind tools (`doc_append`, `session_send`, `diffs_open_file`...), each taking a `blockId` limited to scope, with a read/write/confirm permission.
- **Transport**: the layout server is an MCP server per agent block (`/mcp?block=…`), with `tools/list_changed` when the layout changes and a `mason://context` resource. The same functions back the CLI and the palette.
- Demo: an agent next to "Release notes", diffs and child sessions writes the notes into the doc live.
