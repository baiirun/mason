import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { BlockIdContext, useBlock, useMux, useSyncStatus, useView, useWorkspace } from "./context";
import { builtinCommands, defaultKeymap, normalizeBinding, strokeOf, type Command } from "./commands";
import { LAUNCHER, type Mux } from "./mux";
import { SpaceView } from "./layout";

class BlockBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    return this.state.error ? <div className="mx-error">This block crashed: {this.state.error.message}</div> : this.props.children;
  }
}

/**
 * Renders every block once, in a flat list keyed by id, portalled into the
 * block's long-lived element. The layout only moves those elements around,
 * so blocks keep their React state when dragged, split, or hidden in a tab.
 */
function BlockHost() {
  const mux = useMux();
  const ws = useWorkspace();
  const blocks = Object.values(ws.blocks);
  useEffect(() => {
    mux.pruneElements(new Set(blocks.map((b) => b.id)));
  });
  return (
    <>
      {blocks.map((b) => {
        const def = mux.registry.get(b.kind);
        const Comp = b.kind === LAUNCHER ? Launcher : def?.component;
        return createPortal(
          <BlockIdContext.Provider value={b.id}>
            <BlockBoundary>
              {Comp ? <Comp id={b.id} state={b.state} /> : <div className="mx-error">Unknown block kind “{b.kind}”.</div>}
            </BlockBoundary>
          </BlockIdContext.Provider>,
          mux.element(b.id),
          b.id,
        );
      })}
    </>
  );
}

/** The "new block" picker: a block that replaces itself with what you choose. */
function Launcher() {
  const mux = useMux();
  const block = useBlock();
  const [q, setQ] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (block.isFocused) input.current?.focus();
  }, [block.isFocused]);
  const options = useMemo(
    () =>
      mux.registry
        .all()
        .flatMap((d) => (d.launch?.() ?? []).map((o) => ({ kind: d.kind, name: d.name, icon: d.icon, ...o }))),
    [mux],
  );
  const shown = options.filter((o) => `${o.name} ${o.label}`.toLowerCase().includes(q.toLowerCase()));
  const pick = (o: (typeof options)[number]) => block.replace({ kind: o.kind, state: o.state });
  return (
    <div className="mx-launcher">
      <input
        ref={input}
        placeholder="Open… (type to filter, Enter to pick)"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && shown[0] && pick(shown[0])}
      />
      <ul>
        {shown.map((o) => (
          <li key={`${o.kind}:${o.label}`}>
            <button onClick={() => pick(o)}>
              <span className="mx-tab-icon">{o.icon}</span> <b>{o.name}</b> <span className="mx-dim">{o.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SpaceBar() {
  const mux = useMux();
  const ws = useWorkspace();
  const active = useView((v) => v.activeSpaceId);
  const renaming = useView((v) => v.renaming);
  const dropSpace = useView((v) => (v.drag?.target?.kind === "space" ? v.drag.target.spaceId : null));
  return (
    <div className="mx-spacebar">
      {ws.spaces.map((s, i) => (
        <div
          key={s.id}
          data-mx-space-tab={s.id}
          className={`mx-space-tab${s.id === active ? " is-active" : ""}${dropSpace === s.id ? " is-drop" : ""}`}
          onClick={() => mux.switchSpace(s.id)}
          onDoubleClick={() => mux.view.set({ renaming: s.id })}
        >
          <span className="mx-dim">{i + 1}</span>{" "}
          {renaming === s.id ? (
            <input
              autoFocus
              defaultValue={s.name}
              onBlur={(e) => {
                mux.dispatch({ type: "renameSpace", spaceId: s.id, name: e.target.value || s.name });
                mux.view.set({ renaming: null });
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === "Escape") (e.target as HTMLInputElement).blur();
              }}
            />
          ) : (
            s.name
          )}
        </div>
      ))}
      <button className="mx-space-add" title="New space (ctrl+b c)" onClick={() => mux.newSpace()}>
        +
      </button>
    </div>
  );
}

function DragOverlay() {
  const drag = useView((v) => v.drag);
  const ws = useWorkspace();
  const mux = useMux();
  if (!drag) return null;
  const t = drag.target;
  const rect = t && t.kind !== "space" ? t.rect : null;
  const rec = ws.blocks[drag.blockId];
  return createPortal(
    <>
      {rect && (
        <div
          className={`mx-drop-preview${t?.kind === "tabbar" ? " is-bar" : ""}`}
          style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
        />
      )}
      <div className="mx-drag-ghost" style={{ left: drag.x + 12, top: drag.y + 12 }}>
        {mux.view.state.titles[drag.blockId] ?? (rec && mux.registry.get(rec.kind)?.name) ?? "Block"}
      </div>
    </>,
    document.body,
  );
}

function Palette({ commands }: { commands: Command[] }) {
  const mux = useMux();
  const open = useView((v) => v.palette);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const keymap = useMemo(() => {
    const byCmd: Record<string, string> = {};
    for (const [k, c] of Object.entries(defaultKeymap())) if (!byCmd[c]) byCmd[c] = k;
    return byCmd;
  }, []);
  useEffect(() => {
    if (open) {
      setQ("");
      setSel(0);
    }
  }, [open]);
  if (!open) return null;
  const ql = q.toLowerCase();
  const rank = (c: Command) => (c.title.toLowerCase().startsWith(ql) ? 0 : c.title.toLowerCase().includes(ql) ? 1 : 2);
  const shown = commands
    .filter((c) => `${c.title} ${c.id}`.toLowerCase().includes(ql))
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, 12);
  const close = () => {
    mux.view.set({ palette: false });
    const f = mux.view.state.focused;
    if (f) mux.focus(f);
  };
  const run = (c: Command) => {
    close();
    c.run(mux);
  };
  return (
    <div className="mx-palette-backdrop" onPointerDown={close}>
      <div className="mx-palette" onPointerDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          placeholder="Run a command…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") close();
            if (e.key === "ArrowDown") setSel((s) => Math.min(s + 1, shown.length - 1));
            if (e.key === "ArrowUp") setSel((s) => Math.max(s - 1, 0));
            if (e.key === "Enter" && shown[sel]) run(shown[sel]);
          }}
        />
        <ul>
          {shown.map((c, i) => (
            <li key={c.id} className={i === sel ? "is-sel" : ""} onPointerEnter={() => setSel(i)} onClick={() => run(c)}>
              <span>{c.title}</span>
              <span className="mx-dim">
                {c.id}
                {keymap[c.id] && <kbd>{keymap[c.id]}</kbd>}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function StatusBar() {
  const { connected, pending, version } = useSyncStatus();
  const hint = useView((v) => v.keyHint);
  const zoomed = useView((v) => v.zoomed);
  return (
    <div className="mx-status">
      <span className={`mx-conn ${connected ? "is-on" : "is-off"}`}>{connected ? "● synced" : "○ offline"}</span>
      <span className="mx-dim">
        v{version}
        {pending ? ` · ${pending} pending` : ""}
      </span>
      {zoomed && <span className="mx-mode">ZOOM</span>}
      {hint && <span className="mx-mode">{hint}</span>}
      <span className="mx-dim mx-status-help">
        <kbd>ctrl+b</kbd> leader · <kbd>%</kbd>/<kbd>"</kbd> split · <kbd>hjkl</kbd> focus · <kbd>z</kbd> zoom · <kbd>r</kbd>{" "}
        resize · <kbd>c</kbd> space · <kbd>{/Mac/.test(navigator.platform) ? "⌘" : "ctrl+"}k</kbd> palette
      </span>
    </div>
  );
}

function Toasts() {
  const toasts = useView((v) => v.toasts);
  return (
    <div className="mx-toasts">
      {toasts.map((t) => (
        <div key={t.id} className="mx-toast">
          {t.text}
        </div>
      ))}
    </div>
  );
}

/** Global keyboard handling: sequences ("ctrl+b>x"), modes ("resize/h"), and direct chords. */
function useKeyboard(mux: Mux, commands: Command[], keymap: Record<string, string>) {
  useEffect(() => {
    const byId = new Map(commands.map((c) => [c.id, c]));
    const map = new Map(Object.entries(keymap).map(([k, v]) => [normalizeBinding(k), v]));
    const prefixes = new Set([...map.keys()].filter((k) => k.includes(">")).map((k) => k.split(">")[0]!));
    let prefix: string | null = null;
    let mode: string | null = null;

    const hint = () => mux.view.set({ keyHint: mode ? mode.toUpperCase() : prefix ? `${prefix} …` : null });
    const run = (action: string) => {
      if (action.startsWith("mode:")) {
        mode = action.slice(5);
        return;
      }
      byId.get(action)?.run(mux);
    };

    const onKey = (e: KeyboardEvent) => {
      if (mux.view.state.palette) return;
      const stroke = strokeOf(e);
      if (!stroke) return;
      if (mode) {
        // Modes are exclusive: unbound keys are swallowed, Escape leaves.
        e.preventDefault();
        e.stopPropagation();
        if (stroke === "escape" || stroke === "enter") mode = null;
        else {
          const action = map.get(`${mode}/${stroke}`);
          if (action) run(action);
        }
        return hint();
      }
      if (prefix) {
        e.preventDefault();
        e.stopPropagation();
        const action = map.get(`${prefix}>${stroke}`);
        prefix = null;
        if (action) run(action);
        return hint();
      }
      if (prefixes.has(stroke)) {
        e.preventDefault();
        e.stopPropagation();
        prefix = stroke;
        return hint();
      }
      const action = map.get(stroke);
      if (action) {
        e.preventDefault();
        e.stopPropagation();
        run(action);
        hint();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [mux, commands, keymap]);
}

export interface MuxRootProps {
  /** Extra commands (shown in the palette, bindable in `keymap`). */
  commands?: Command[];
  /** Overrides merged over the default keymap. Map a key to "" to unbind it. */
  keymap?: Record<string, string>;
}

const NO_COMMANDS: Command[] = [];
const NO_KEYS: Record<string, string> = {};

/** The whole multiplexer UI: space bar, layout, status bar, palette. */
export function MuxRoot({ commands: extra = NO_COMMANDS, keymap: overrides = NO_KEYS }: MuxRootProps) {
  const mux = useMux();
  const { ready } = useSyncStatus();
  const commands = useMemo(() => [...builtinCommands(), ...extra], [extra]);
  const keymap = useMemo(() => {
    const m = { ...defaultKeymap(), ...overrides };
    for (const k of Object.keys(m)) if (!m[k]) delete m[k];
    return m;
  }, [overrides]);
  useKeyboard(mux, commands, keymap);
  return (
    <div className="mx-root">
      <SpaceBar />
      {ready ? <SpaceView /> : <div className="mx-empty">Connecting to the layout server…</div>}
      <StatusBar />
      <BlockHost />
      <DragOverlay />
      <Palette commands={commands} />
      <Toasts />
    </div>
  );
}
