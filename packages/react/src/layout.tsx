import { Fragment, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { findStack, type LayoutNode, type SplitNode, type StackNode } from "@mason/core";
import { useMux, useView, useWorkspace } from "./context";
import { beginTabDrag } from "./dnd";
import { LAUNCHER } from "./mux";

/** An empty box the block's long-lived DOM element is moved into. Moving it never remounts the React tree. */
function Slot({ blockId }: { blockId: string }) {
  const mux = useMux();
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = ref.current!;
    const el = mux.element(blockId);
    host.appendChild(el);
    mux.setVisible(blockId, true);
    return () => {
      if (el.parentNode === host) host.removeChild(el);
      mux.setVisible(blockId, false);
    };
  }, [mux, blockId]);
  return <div ref={ref} className="mx-slot" />;
}

function useTitle(blockId: string) {
  const mux = useMux();
  const ws = useWorkspace();
  const custom = useView((v) => v.titles[blockId]);
  const rec = ws.blocks[blockId];
  if (!rec) return "";
  const def = mux.registry.get(rec.kind);
  if (custom) return custom;
  if (def?.title) return def.title(rec.state);
  return def?.name ?? (rec.kind === LAUNCHER ? "New block" : rec.kind);
}

function Tab({ blockId, active, focused }: { blockId: string; active: boolean; focused: boolean }) {
  const mux = useMux();
  const ws = useWorkspace();
  const title = useTitle(blockId);
  const dragging = useView((v) => v.drag?.blockId === blockId);
  const rec = ws.blocks[blockId];
  const def = rec && mux.registry.get(rec.kind);
  return (
    <div
      data-mx-tab={blockId}
      className={`mx-tab${active ? " is-active" : ""}${focused ? " is-focused" : ""}${dragging ? " is-dragging" : ""}`}
      onPointerDown={(e) => {
        if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
        e.preventDefault();
        beginTabDrag(mux, blockId, e.nativeEvent, () => mux.focus(blockId));
      }}
      onAuxClick={(e) => e.button === 1 && mux.close(blockId)}
      title={rec?.kind}
    >
      {def?.icon && <span className="mx-tab-icon">{def.icon}</span>}
      <span className="mx-tab-title">{title}</span>
      <button
        className={`mx-link mx-link-${rec?.link ?? "none"}`}
        title={rec?.link ? `Link group ${rec.link} (click to change)` : "Not linked (click to link)"}
        onClick={() => mux.cycleLink(blockId)}
      >
        {rec?.link ?? "·"}
      </button>
      <button
        className={`mx-tab-hide${rec?.hidden ? " is-hidden" : ""}`}
        title={rec?.hidden ? "Hidden from agents (click to share)" : "Visible to agents (click to hide)"}
        onClick={() => mux.dispatch({ type: "setHidden", blockId, hidden: !rec?.hidden })}
      >
        {rec?.hidden ? "⊘" : "◉"}
      </button>
      <button className="mx-tab-close" title="Close" onClick={() => mux.close(blockId)}>
        ×
      </button>
    </div>
  );
}

function StackView({ node }: { node: StackNode }) {
  const mux = useMux();
  const focused = useView((v) => v.focused);
  const hasFocus = !!focused && node.blocks.includes(focused);
  return (
    <div className={`mx-stack${hasFocus ? " has-focus" : ""}`}>
      <div className="mx-tabbar" data-mx-tabbar={node.id}>
        {node.blocks.map((id) => (
          <Tab key={id} blockId={id} active={id === node.active} focused={hasFocus && id === node.active} />
        ))}
        <button
          className="mx-tab-add"
          title="New tab"
          onClick={() => mux.open(node.active, { kind: LAUNCHER }, { placement: "tab" })}
        >
          +
        </button>
      </div>
      <div
        className="mx-stack-body"
        data-mx-stack={node.id}
        onPointerDownCapture={() => focused !== node.active && mux.focus(node.active)}
        onFocusCapture={() => mux.view.state.focused !== node.active && mux.view.set({ focused: node.active })}
      >
        <Slot key={node.active} blockId={node.active} />
      </div>
    </div>
  );
}

function SplitView({ node }: { node: SplitNode }) {
  const mux = useMux();
  const ref = useRef<HTMLDivElement>(null);
  // Sizes are local while dragging a splitter; one resize op is sent on release.
  const [live, setLive] = useState<number[] | null>(null);
  const sizes = live ?? node.sizes;

  const startResize = (i: number, e: React.PointerEvent) => {
    e.preventDefault();
    const box = ref.current!.getBoundingClientRect();
    const total = node.dir === "row" ? box.width : box.height;
    const start = node.dir === "row" ? e.clientX : e.clientY;
    const base = [...node.sizes];
    let current = base;
    document.body.classList.add(node.dir === "row" ? "mx-resizing-row" : "mx-resizing-col");
    const move = (ev: PointerEvent) => {
      const d = ((node.dir === "row" ? ev.clientX : ev.clientY) - start) / total;
      const min = 0.06;
      const pair = base[i]! + base[i + 1]!;
      const a = Math.min(Math.max(base[i]! + d, min), pair - min);
      current = [...base];
      current[i] = a;
      current[i + 1] = pair - a;
      setLive(current);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("mx-resizing-row", "mx-resizing-col");
      setLive(null);
      if (current !== base) mux.dispatch({ type: "resize", splitId: node.id, sizes: current });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div ref={ref} className={`mx-split mx-split-${node.dir}`}>
      {node.children.map((child, i) => (
        <Fragment key={child.id}>
          {i > 0 && <div className={`mx-gutter mx-gutter-${node.dir}`} onPointerDown={(e) => startResize(i - 1, e)} />}
          <div className="mx-split-child" style={{ flex: `${sizes[i]} 1 0px` } as CSSProperties}>
            <LayoutView node={child} />
          </div>
        </Fragment>
      ))}
    </div>
  );
}

export function LayoutView({ node }: { node: LayoutNode }) {
  return node.type === "stack" ? <StackView node={node} /> : <SplitView node={node} />;
}

/** The active space's layout, or just the zoomed block's stack. */
export function SpaceView() {
  const mux = useMux();
  const ws = useWorkspace();
  const activeSpaceId = useView((v) => v.activeSpaceId);
  const zoomed = useView((v) => v.zoomed);
  const space = ws.spaces.find((s) => s.id === activeSpaceId) ?? ws.spaces[0];
  if (!space) return <div className="mx-empty">No spaces yet.</div>;
  const zoomStack = zoomed ? findStack(space.root, zoomed) : undefined;
  return (
    <div className="mx-space" data-mx-space-root>
      {zoomStack ? (
        <div className="mx-zoomed">
          <StackView node={{ ...zoomStack, active: zoomed! }} />
        </div>
      ) : space.root ? (
        <LayoutView node={space.root} />
      ) : (
        <div className="mx-empty">
          Empty space.{" "}
          <button onClick={() => mux.open(null, { kind: LAUNCHER })}>Open a block</button>
        </div>
      )}
    </div>
  );
}
