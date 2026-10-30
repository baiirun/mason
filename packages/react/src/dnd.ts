import { dropZone, findStack, zoneRect, type Edge, type Op, type Rect } from "@mason/core";
import type { DropTarget, Mux } from "./mux";

const ROOT_EDGE_PX = 28;
const SPACE_HOVER_MS = 450;

const rectOf = (el: Element): Rect => {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
};

/** Work out the drop target under the pointer. Pointer events only, no HTML5 DnD. */
function hitTest(mux: Mux, blockId: string, x: number, y: number): DropTarget | null {
  const els = document.elementsFromPoint(x, y);
  const spaceTab = els.find((e) => e instanceof HTMLElement && e.dataset.mxSpaceTab) as HTMLElement | undefined;
  if (spaceTab) return { kind: "space", spaceId: spaceTab.dataset.mxSpaceTab! };

  const rootEl = document.querySelector("[data-mx-space-root]");
  if (rootEl) {
    const r = rectOf(rootEl);
    const inside = x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
    const edges: [Edge, number][] = [
      ["left", x - r.x],
      ["right", r.x + r.w - x],
      ["up", y - r.y],
      ["down", r.y + r.h - y],
    ];
    const near = edges.filter(([, d]) => d < ROOT_EDGE_PX).sort((a, b) => a[1] - b[1])[0];
    if (inside && near) return { kind: "root", zone: near[0], rect: zoneRect(r, near[0]) };
  }

  const tabbar = els.find((e) => e instanceof HTMLElement && e.dataset.mxTabbar) as HTMLElement | undefined;
  if (tabbar) {
    const tabs = [...tabbar.querySelectorAll<HTMLElement>("[data-mx-tab]")];
    let index = tabs.findIndex((t) => {
      const r = t.getBoundingClientRect();
      return x < r.x + r.width / 2;
    });
    if (index < 0) index = tabs.length;
    const marker = tabs[index] ?? tabs[tabs.length - 1];
    const mr = marker ? rectOf(marker) : rectOf(tabbar);
    const atEnd = index >= tabs.length;
    return {
      kind: "tabbar",
      stackId: tabbar.dataset.mxTabbar!,
      index,
      rect: { x: atEnd ? mr.x + mr.w - 2 : mr.x - 2, y: mr.y, w: 4, h: mr.h },
    };
  }

  const stackEl = els.find((e) => e instanceof HTMLElement && e.dataset.mxStack) as HTMLElement | undefined;
  if (stackEl) {
    const r = rectOf(stackEl);
    const zone = dropZone(r, x, y);
    const stackId = stackEl.dataset.mxStack!;
    // Dropping a lone block onto its own stack does nothing.
    const space = mux.activeSpace();
    const own = space && findStack(space.root, blockId);
    if (own?.id === stackId && own.blocks.length === 1) return null;
    if (own?.id === stackId && zone === "center") return null;
    return { kind: "stack", stackId, zone, rect: zoneRect(r, zone) };
  }
  return null;
}

function opFor(mux: Mux, blockId: string, t: DropTarget): Op | null {
  const space = mux.activeSpace();
  if (!space) return null;
  switch (t.kind) {
    case "space":
      if (mux.spaceOf(blockId)?.id === t.spaceId) return null;
      return { type: "moveBlock", blockId, spaceId: t.spaceId, at: mux.splitAt("root", "right") };
    case "root":
      return { type: "moveBlock", blockId, spaceId: space.id, at: mux.splitAt("root", t.zone) };
    case "tabbar": {
      const stack = findStack(space.root, t.stackId);
      let index = t.index;
      if (stack?.blocks.includes(blockId)) {
        const from = stack.blocks.indexOf(blockId);
        if (from < index) index--;
        if (from === index || stack.blocks.length === 1) return null;
      }
      return { type: "moveBlock", blockId, spaceId: space.id, at: { mode: "tab", target: t.stackId, index } };
    }
    case "stack":
      if (t.zone === "center") return { type: "moveBlock", blockId, spaceId: space.id, at: { mode: "tab", target: t.stackId } };
      return { type: "moveBlock", blockId, spaceId: space.id, at: mux.splitAt(t.stackId, t.zone) };
  }
}

/** Start a drag from a tab's pointerdown. Becomes a drag after 4px; otherwise it's a click. */
export function beginTabDrag(mux: Mux, blockId: string, e: PointerEvent, onClick: () => void) {
  const sx = e.clientX;
  const sy = e.clientY;
  let dragging = false;
  let hoverSpace: { id: string; timer: number } | null = null;

  const move = (ev: PointerEvent) => {
    if (!dragging && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
    if (!dragging) {
      dragging = true;
      document.body.classList.add("mx-dragging");
    }
    const target = hitTest(mux, blockId, ev.clientX, ev.clientY);
    // Hovering a space tab switches to it, so you can drop into its layout.
    if (target?.kind === "space") {
      if (hoverSpace?.id !== target.spaceId) {
        if (hoverSpace) clearTimeout(hoverSpace.timer);
        const id = target.spaceId;
        hoverSpace = { id, timer: window.setTimeout(() => mux.view.set({ activeSpaceId: id }), SPACE_HOVER_MS) };
      }
    } else if (hoverSpace) {
      clearTimeout(hoverSpace.timer);
      hoverSpace = null;
    }
    mux.view.set({ drag: { blockId, x: ev.clientX, y: ev.clientY, target } });
  };

  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("keydown", cancel, true);
    if (hoverSpace) clearTimeout(hoverSpace.timer);
    document.body.classList.remove("mx-dragging");
    const drag = mux.view.state.drag;
    mux.view.set({ drag: null });
    if (!dragging) return onClick();
    const op = drag?.target && opFor(mux, blockId, drag.target);
    if (op) {
      mux.dispatch(op);
      mux.focus(blockId);
    }
  };

  const cancel = (ev: KeyboardEvent) => {
    if (ev.key !== "Escape") return;
    ev.stopPropagation();
    mux.view.set({ drag: { ...mux.view.state.drag!, target: null } });
    up();
  };

  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("keydown", cancel, true);
}
