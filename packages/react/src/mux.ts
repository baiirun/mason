import {
  findStack,
  pickDirectional,
  stacks,
  SyncClient,
  uid,
  type BlockRecord,
  type Edge,
  type LayoutNode,
  type Op,
  type Placement,
  type Rect,
  type ServerMsg,
  type Space,
  type Workspace,
} from "@mason/core";
import type { BlockRegistry } from "./registry";

export const LAUNCHER = "mason.launcher";
export const LINK_GROUPS = ["A", "B", "C"] as const;

export type DropTarget =
  | { kind: "stack"; stackId: string; zone: Edge | "center"; rect: Rect }
  | { kind: "root"; zone: Edge; rect: Rect }
  | { kind: "tabbar"; stackId: string; index: number; rect: Rect }
  | { kind: "space"; spaceId: string };

export interface DragState {
  blockId: string;
  x: number;
  y: number;
  target: DropTarget | null;
}

/** Per-client view state. Never sent to the server. */
export interface ViewState {
  activeSpaceId: string | null;
  focused: string | null;
  zoomed: string | null;
  connected: boolean;
  drag: DragState | null;
  /** Leader prefix or mode name shown in the status bar. */
  keyHint: string | null;
  palette: boolean;
  renaming: string | null;
  titles: Record<string, string>;
  visible: Record<string, boolean>;
  links: Record<string, unknown>;
  toasts: { id: number; text: string }[];
}

export type Placement2 = "right" | "left" | "up" | "down" | "tab";

export interface OpenSpec {
  kind: string;
  state?: Record<string, unknown>;
  link?: string | null;
}

export interface OpenOptions {
  placement?: Placement2;
  /** Focus an existing block with the same kind+state instead of opening a duplicate. */
  reuse?: boolean;
  focus?: boolean;
}

class Store<T> {
  private listeners = new Set<() => void>();
  constructor(public state: T) {}
  get = () => this.state;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  set(patch: Partial<T> | ((s: T) => Partial<T>)) {
    const p = typeof patch === "function" ? patch(this.state) : patch;
    this.state = { ...this.state, ...p };
    for (const fn of this.listeners) fn();
  }
}

const sameState = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function loadView(): Partial<ViewState> {
  try {
    return JSON.parse(sessionStorage.getItem("mason:view") ?? "{}");
  } catch {
    return {};
  }
}

/**
 * One mux per app. Owns the optimistic sync client (shared, server-owned
 * layout), the per-client view store (focus, zoom, drag...) and the DOM
 * elements that blocks are portalled into.
 */
export class Mux {
  sync: SyncClient;
  view: Store<ViewState>;
  private socket?: WebSocket;
  private elements = new Map<string, HTMLDivElement>();
  private toastSeq = 0;
  private retry = 500;

  constructor(
    public registry: BlockRegistry,
    private url: string,
  ) {
    let clientId = sessionStorage.getItem("mason:client");
    if (!clientId) sessionStorage.setItem("mason:client", (clientId = uid("client-")));
    const saved = loadView();
    this.view = new Store<ViewState>({
      activeSpaceId: saved.activeSpaceId ?? null,
      focused: saved.focused ?? null,
      zoomed: saved.zoomed ?? null,
      connected: false,
      drag: null,
      keyHint: null,
      palette: false,
      renaming: null,
      titles: {},
      visible: {},
      links: {},
      toasts: [],
    });
    this.view.subscribe(() => {
      const { activeSpaceId, focused, zoomed } = this.view.state;
      try {
        sessionStorage.setItem("mason:view", JSON.stringify({ activeSpaceId, focused, zoomed }));
      } catch {}
    });
    this.sync = new SyncClient({
      clientId,
      send: (m) => this.socket?.readyState === WebSocket.OPEN && this.socket.send(JSON.stringify(m)),
      onReject: (op, reason) => this.toast(`Server rejected ${op.type} (${reason}); reverted.`),
    });
    this.sync.subscribe(() => this.repairView());
  }

  connect() {
    const ws = new WebSocket(this.url);
    this.socket = ws;
    ws.onopen = () => {
      this.retry = 500;
      this.sync.onOpen();
      this.view.set({ connected: true });
    };
    ws.onmessage = (e) => this.sync.receive(JSON.parse(e.data) as ServerMsg);
    ws.onclose = () => {
      if (this.socket !== ws) return;
      this.sync.onClose();
      this.view.set({ connected: false });
      setTimeout(() => this.connect(), (this.retry = Math.min(this.retry * 2, 5000)));
    };
  }

  disconnect() {
    const ws = this.socket;
    this.socket = undefined;
    ws?.close();
  }

  // ---- state helpers -------------------------------------------------------

  get ws(): Workspace {
    return this.sync.view;
  }

  activeSpace(): Space | undefined {
    const { activeSpaceId } = this.view.state;
    return this.ws.spaces.find((s) => s.id === activeSpaceId) ?? this.ws.spaces[0];
  }

  spaceOf(blockId: string): Space | undefined {
    return this.ws.spaces.find((s) => findStack(s.root, blockId));
  }

  /** Keep focus/zoom/active space pointing at things that still exist. */
  private repairView() {
    if (!this.sync.ready) return;
    const v = this.view.state;
    const space = this.activeSpace();
    const patch: Partial<ViewState> = {};
    if (space?.id !== v.activeSpaceId) patch.activeSpaceId = space?.id ?? null;
    if (!v.focused || !space || !findStack(space.root, v.focused)) {
      const first = space && [...stacks(space.root)][0];
      patch.focused = first?.active ?? null;
    }
    if (v.zoomed && (!space || !findStack(space.root, v.zoomed))) patch.zoomed = null;
    if (Object.keys(patch).length) this.view.set(patch);
  }

  dispatch(op: Op) {
    return this.sync.dispatch(op);
  }

  toast(text: string) {
    const id = ++this.toastSeq;
    this.view.set((s) => ({ toasts: [...s.toasts, { id, text }] }));
    setTimeout(() => this.view.set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 4000);
  }

  // ---- portals -------------------------------------------------------------

  element(blockId: string) {
    let el = this.elements.get(blockId);
    if (!el) {
      el = document.createElement("div");
      el.className = "mx-block-root";
      el.tabIndex = -1;
      el.dataset.block = blockId;
      this.elements.set(blockId, el);
    }
    return el;
  }

  pruneElements(alive: Set<string>) {
    for (const [id, el] of this.elements) {
      if (!alive.has(id)) {
        el.remove();
        this.elements.delete(id);
      }
    }
  }

  setVisible(blockId: string, visible: boolean) {
    this.view.set((s) => ({ visible: { ...s.visible, [blockId]: visible } }));
  }

  // ---- focus & spaces ------------------------------------------------------

  focus(blockId: string) {
    const space = this.spaceOf(blockId);
    if (!space) return;
    const stack = findStack(space.root, blockId)!;
    if (stack.active !== blockId) this.dispatch({ type: "setActive", blockId });
    this.view.set({ focused: blockId, activeSpaceId: space.id });
    // Move DOM focus too, unless focus is already inside the block.
    requestAnimationFrame(() => {
      const el = this.elements.get(blockId);
      if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
    });
  }

  switchSpace(spaceId: string) {
    const space = this.ws.spaces.find((s) => s.id === spaceId);
    if (!space) return;
    const first = [...stacks(space.root)][0];
    this.view.set({ activeSpaceId: spaceId, focused: first?.active ?? null, zoomed: null });
  }

  cycleSpace(delta: number) {
    const spaces = this.ws.spaces;
    const i = spaces.findIndex((s) => s.id === this.activeSpace()?.id);
    const next = spaces[(i + delta + spaces.length) % spaces.length];
    if (next) this.switchSpace(next.id);
  }

  newSpace(name = `Space ${this.ws.spaces.length + 1}`) {
    const spaceId = uid("space-");
    const block: BlockRecord = { id: uid("block-"), kind: LAUNCHER, state: {} };
    this.dispatch({ type: "addSpace", spaceId, name });
    this.dispatch({ type: "openBlock", spaceId, block, at: this.splitAt("root", "right") });
    this.switchSpace(spaceId);
    this.focus(block.id);
  }

  /** Geometry of visible stacks, from the DOM. */
  stackRects(): { stackId: string; blockId: string; rect: Rect }[] {
    const space = this.activeSpace();
    if (!space) return [];
    return [...stacks(space.root)].flatMap((s) => {
      const el = document.querySelector<HTMLElement>(`[data-mx-stack="${s.id}"]`);
      if (!el) return [];
      const r = el.getBoundingClientRect();
      return [{ stackId: s.id, blockId: s.active, rect: { x: r.x, y: r.y, w: r.width, h: r.height } }];
    });
  }

  neighbor(dir: Edge) {
    const rects = this.stackRects();
    const { focused } = this.view.state;
    const space = this.activeSpace();
    const from = focused && space ? rects.find((r) => r.stackId === findStack(space.root, focused)?.id) : undefined;
    return from ? pickDirectional(rects, from.rect, dir) : undefined;
  }

  // ---- opening blocks ------------------------------------------------------

  splitAt(target: string, edge: Edge): Placement {
    return { mode: "split", target, edge, stackId: uid("stack-"), splitId: uid("split-") };
  }

  /** What `useBlock().open` calls: show another block relative to `from`. */
  open(from: string | null, spec: OpenSpec, opts: OpenOptions = {}) {
    const space = (from && this.spaceOf(from)) || this.activeSpace();
    if (!space) return null;
    const state = spec.state ?? {};
    if (opts.reuse) {
      const existing = Object.values(this.ws.blocks).find(
        (b) => b.kind === spec.kind && sameState(b.state, state) && findStack(space.root, b.id),
      );
      if (existing) {
        this.focus(existing.id);
        return existing.id;
      }
    }
    const block: BlockRecord = { id: uid("block-"), kind: spec.kind, state, link: spec.link ?? null };
    const placement = opts.placement ?? "right";
    const target = from && findStack(space.root, from) ? from : "root";
    const at: Placement =
      placement === "tab" && target !== "root"
        ? { mode: "tab", target }
        : this.splitAt(target, placement === "tab" ? "right" : placement);
    this.dispatch({ type: "openBlock", spaceId: space.id, block, at });
    if (opts.focus !== false) this.focus(block.id);
    return block.id;
  }

  close(blockId: string) {
    const space = this.spaceOf(blockId);
    let next: string | undefined;
    if (space && this.view.state.focused === blockId) {
      const stack = findStack(space.root, blockId)!;
      next = stack.blocks.find((b) => b !== blockId) ?? this.neighbor("left")?.blockId ?? this.neighbor("right")?.blockId ?? this.neighbor("up")?.blockId ?? this.neighbor("down")?.blockId;
    }
    this.dispatch({ type: "closeBlock", blockId });
    if (next) this.focus(next);
  }

  /** Resize the split around the focused block along `dir` by `delta` (fraction). */
  resizeFocused(dir: Edge, delta = 0.05) {
    const space = this.activeSpace();
    const focused = this.view.state.focused;
    if (!space?.root || !focused) return;
    const axis = dir === "left" || dir === "right" ? "row" : "col";
    const grow = dir === "right" || dir === "down" ? delta : -delta;
    // Walk from the focused stack upward to the nearest split on this axis.
    const path: LayoutNode[] = [];
    const find = (n: LayoutNode): boolean => {
      path.push(n);
      if (n.type === "stack") {
        if (n.blocks.includes(focused)) return true;
      } else if (n.children.some(find)) return true;
      path.pop();
      return false;
    };
    find(space.root);
    for (let i = path.length - 2; i >= 0; i--) {
      const split = path[i]!;
      if (split.type !== "split" || split.dir !== axis) continue;
      const idx = split.children.indexOf(path[i + 1]!);
      // Grow/shrink the boundary to the right/below the focused child; last child uses its left boundary.
      const j = idx < split.children.length - 1 ? idx : idx - 1;
      const sizes = [...split.sizes];
      const d = idx < split.children.length - 1 ? grow : -grow;
      const a = sizes[j]! + d;
      const b = sizes[j + 1]! - d;
      if (a < 0.08 || b < 0.08) return;
      sizes[j] = a;
      sizes[j + 1] = b;
      this.dispatch({ type: "resize", splitId: split.id, sizes });
      return;
    }
  }

  cycleTab(delta: number) {
    const space = this.activeSpace();
    const focused = this.view.state.focused;
    const stack = focused && space ? findStack(space.root, focused) : undefined;
    if (!stack || stack.blocks.length < 2) return;
    const i = stack.blocks.indexOf(focused!);
    this.focus(stack.blocks[(i + delta + stack.blocks.length) % stack.blocks.length]!);
  }

  cycleLink(blockId: string) {
    const b = this.ws.blocks[blockId];
    if (!b) return;
    const order = [null, ...LINK_GROUPS];
    const next = order[(order.indexOf((b.link ?? null) as never) + 1) % order.length]!;
    this.dispatch({ type: "setLink", blockId, link: next });
  }

  // ---- links ---------------------------------------------------------------

  publishLink(group: string, channel: string, value: unknown) {
    const key = `${group}:${channel}`;
    if (sameState(this.view.state.links[key], value)) return;
    this.view.set((s) => ({ links: { ...s.links, [key]: value } }));
  }
}
