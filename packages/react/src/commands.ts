import { findStack, stacks, type Edge } from "@mason/core";
import { LAUNCHER, type Mux } from "./mux";

export interface Command {
  id: string;
  title: string;
  run: (mux: Mux) => void;
}

const dirs: [Edge, string][] = [
  ["left", "h"],
  ["down", "j"],
  ["up", "k"],
  ["right", "l"],
];

const focusedOr = (mux: Mux, fn: (id: string) => void) => {
  const id = mux.view.state.focused;
  if (id) fn(id);
};

/** Every action is a named command: keys, the palette, and code all go through these. */
export function builtinCommands(): Command[] {
  const cmds: Command[] = [];
  for (const [dir] of dirs) {
    cmds.push({
      id: `block.split.${dir}`,
      title: `Split ${dir}`,
      run: (m) => m.open(m.view.state.focused, { kind: LAUNCHER }, { placement: dir }),
    });
    cmds.push({
      id: `focus.${dir}`,
      title: `Focus ${dir}`,
      run: (m) => {
        const n = m.neighbor(dir);
        if (n) m.focus(n.blockId);
      },
    });
    cmds.push({
      id: `block.join.${dir}`,
      title: `Move block into the stack ${dir}`,
      run: (m) =>
        focusedOr(m, (id) => {
          const n = m.neighbor(dir);
          const space = m.activeSpace();
          if (!n || !space) return;
          m.dispatch({ type: "moveBlock", blockId: id, spaceId: space.id, at: { mode: "tab", target: n.stackId } });
          m.focus(id);
        }),
    });
    cmds.push({ id: `block.resize.${dir}`, title: `Resize ${dir}`, run: (m) => m.resizeFocused(dir) });
  }
  cmds.push(
    { id: "block.newTab", title: "New tab", run: (m) => m.open(m.view.state.focused, { kind: LAUNCHER }, { placement: "tab" }) },
    { id: "block.close", title: "Close block", run: (m) => focusedOr(m, (id) => m.close(id)) },
    {
      id: "block.zoom",
      title: "Toggle zoom",
      run: (m) => focusedOr(m, (id) => m.view.set((s) => ({ zoomed: s.zoomed === id ? null : id }))),
    },
    {
      id: "block.breakOut",
      title: "Move block to a new space",
      run: (m) =>
        focusedOr(m, (id) => {
          const spaceId = `space-${crypto.randomUUID().slice(0, 8)}`;
          m.dispatch({ type: "addSpace", spaceId, name: m.view.state.titles[id] ?? "Space" });
          m.dispatch({ type: "moveBlock", blockId: id, spaceId, at: m.splitAt("root", "right") });
          m.switchSpace(spaceId);
          m.focus(id);
        }),
    },
    { id: "block.link.cycle", title: "Cycle link group", run: (m) => focusedOr(m, (id) => m.cycleLink(id)) },
    { id: "tab.next", title: "Next tab", run: (m) => m.cycleTab(1) },
    { id: "tab.prev", title: "Previous tab", run: (m) => m.cycleTab(-1) },
    {
      id: "focus.next",
      title: "Focus next block",
      run: (m) => {
        const space = m.activeSpace();
        const list = [...stacks(space?.root ?? null)];
        const cur = m.view.state.focused;
        const i = list.findIndex((s) => cur && findStack(s, cur));
        const next = list[(i + 1) % list.length];
        if (next) m.focus(next.active);
      },
    },
    { id: "space.new", title: "New space", run: (m) => m.newSpace() },
    { id: "space.next", title: "Next space", run: (m) => m.cycleSpace(1) },
    { id: "space.prev", title: "Previous space", run: (m) => m.cycleSpace(-1) },
    { id: "space.rename", title: "Rename space", run: (m) => m.view.set({ renaming: m.activeSpace()?.id ?? null }) },
    {
      id: "space.close",
      title: "Close space",
      run: (m) => {
        const s = m.activeSpace();
        if (!s || m.ws.spaces.length < 2) return;
        m.cycleSpace(-1);
        m.dispatch({ type: "removeSpace", spaceId: s.id });
      },
    },
    { id: "palette.open", title: "Command palette", run: (m) => m.view.set({ palette: true }) },
  );
  for (let i = 1; i <= 9; i++) {
    cmds.push({
      id: `space.goto.${i}`,
      title: `Go to space ${i}`,
      run: (m) => {
        const s = m.ws.spaces[i - 1];
        if (s) m.switchSpace(s.id);
      },
    });
  }
  return cmds;
}

/**
 * Rex-style keymap: "a>b" is a sequence, "mode/key" binds inside a mode.
 * `ctrl+b` is the tmux-style leader; `alt+…` chords are direct, i3-style.
 */
export function defaultKeymap(): Record<string, string> {
  const map: Record<string, string> = {
    "ctrl+b>%": "block.split.right",
    'ctrl+b>"': "block.split.down",
    "ctrl+b>x": "block.close",
    "ctrl+b>z": "block.zoom",
    "ctrl+b>t": "block.newTab",
    "ctrl+b>!": "block.breakOut",
    "ctrl+b>g": "block.link.cycle",
    "ctrl+b>c": "space.new",
    "ctrl+b>n": "space.next",
    "ctrl+b>p": "space.prev",
    "ctrl+b>,": "space.rename",
    "ctrl+b>&": "space.close",
    "ctrl+b>o": "focus.next",
    "ctrl+b>]": "tab.next",
    "ctrl+b>[": "tab.prev",
    "ctrl+b>r": "mode:resize",
    "ctrl+b>:": "palette.open",
    "mod+k": "palette.open",
    "alt+enter": "block.split.right",
    "alt+shift+enter": "block.split.down",
    "alt+w": "block.close",
    "alt+f": "block.zoom",
    "alt+]": "tab.next",
    "alt+[": "tab.prev",
  };
  for (const [dir, key] of dirs) {
    map[`ctrl+b>${key}`] = `focus.${dir}`;
    map[`ctrl+b>shift+${key}`] = `block.join.${dir}`;
    map[`alt+${key}`] = `focus.${dir}`;
    map[`alt+shift+${key}`] = `block.join.${dir}`;
    map[`resize/${key}`] = `block.resize.${dir}`;
  }
  for (let i = 1; i <= 9; i++) {
    map[`ctrl+b>${i}`] = `space.goto.${i}`;
    map[`alt+${i}`] = `space.goto.${i}`;
  }
  return map;
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** Normalize a KeyboardEvent to "ctrl+alt+shift+key". Letters/digits use the physical key so alt+h works on macOS. */
export function strokeOf(e: KeyboardEvent): string | null {
  if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return null;
  let key: string;
  let shift = e.shiftKey;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3).toLowerCase();
  else if (/^Digit\d$/.test(e.code) && !e.shiftKey) key = e.code.slice(5);
  else if (e.key === "Enter" || e.key === "Escape" || e.key === "Tab") key = e.key.toLowerCase();
  else if (e.key.length === 1) {
    key = e.key;
    shift = false; // "%", '"', "!" already encode shift
  } else key = e.key.toLowerCase();
  if (e.code === "BracketLeft" || e.code === "BracketRight") {
    key = e.code === "BracketLeft" ? "[" : "]";
  }
  // On macOS meta is "mod"; elsewhere ctrl doubles as mod (see normalizeBinding).
  const out: string[] = [];
  if (e.ctrlKey) out.push("ctrl");
  if (isMac && e.metaKey) out.push("mod");
  if (e.altKey) out.push("alt");
  if (shift) out.push("shift");
  out.push(key);
  return out.join("+");
}

/** Lookup that treats "mod" as ctrl on non-Mac platforms. */
export function normalizeBinding(b: string) {
  return isMac ? b : b.replace(/\bmod\b/g, "ctrl");
}
