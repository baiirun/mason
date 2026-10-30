import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import type { BlockRecord, Workspace } from "@mason/core";
import { Mux, type OpenOptions, type OpenSpec, type ViewState } from "./mux";
import type { BlockRegistry } from "./registry";

const MuxContext = createContext<Mux | null>(null);
export const BlockIdContext = createContext<string | null>(null);

export function MuxProvider({ registry, url, children }: { registry: BlockRegistry; url?: string; children: ReactNode }) {
  const [mux] = useState(() => {
    const wsUrl = url ?? `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
    return new Mux(registry, wsUrl);
  });
  useEffect(() => {
    mux.connect();
    return () => mux.disconnect();
  }, [mux]);
  return <MuxContext.Provider value={mux}>{children}</MuxContext.Provider>;
}

export function useMux() {
  const mux = useContext(MuxContext);
  if (!mux) throw new Error("useMux must be used inside <MuxProvider>");
  return mux;
}

export function useWorkspace(): Workspace {
  const mux = useMux();
  return useSyncExternalStore(mux.sync.subscribe, mux.sync.getState);
}

export function useView<T>(select: (v: ViewState) => T): T {
  const mux = useMux();
  return useSyncExternalStore(mux.view.subscribe, () => select(mux.view.state));
}

export function useSyncStatus() {
  const mux = useMux();
  useWorkspace();
  const connected = useView((v) => v.connected);
  return { connected, pending: mux.sync.pending.length, version: mux.sync.version, ready: mux.sync.ready };
}

export interface BlockHandle<S> {
  id: string;
  kind: string;
  state: S;
  link: string | null;
  isFocused: boolean;
  isVisible: boolean;
  /** Merge into this block's server-owned state (optimistic). */
  setState(patch: Partial<S>): void;
  /** Per-client tab title. */
  setTitle(title: string): void;
  focus(): void;
  close(): void;
  /** Show another block relative to this one: split right/left/up/down, or a tab next to it. */
  open(spec: OpenSpec, opts?: OpenOptions): string | null;
  /** Turn this block into another kind in place. */
  replace(spec: { kind: string; state?: Record<string, unknown> }): void;
}

export function useBlock<S = Record<string, unknown>>(): BlockHandle<S> {
  const mux = useMux();
  const id = useContext(BlockIdContext);
  if (!id) throw new Error("useBlock must be used inside a block");
  const ws = useWorkspace();
  const isFocused = useView((v) => v.focused === id);
  const isVisible = useView((v) => !!v.visible[id]);
  const rec = ws.blocks[id] as BlockRecord | undefined;
  return useMemo(
    () => ({
      id,
      kind: rec?.kind ?? "",
      state: (rec?.state ?? {}) as S,
      link: rec?.link ?? null,
      isFocused,
      isVisible,
      setState: (patch) => mux.dispatch({ type: "setBlockState", blockId: id, patch: patch as Record<string, unknown> }),
      setTitle: (title) => {
        if (mux.view.state.titles[id] !== title) mux.view.set((s) => ({ titles: { ...s.titles, [id]: title } }));
      },
      focus: () => mux.focus(id),
      close: () => mux.close(id),
      open: (spec, opts) => mux.open(id, { link: spec.link === undefined ? rec?.link : spec.link, ...spec }, opts),
      replace: ({ kind, state = {} }) => mux.dispatch({ type: "replaceBlock", blockId: id, kind, state }),
    }),
    [mux, id, rec, isFocused, isVisible],
  );
}

/** Read a value published on `channel` by another block in this block's link group. */
export function useLinkValue<T>(channel: string): T | undefined {
  const mux = useMux();
  const id = useContext(BlockIdContext);
  const ws = useWorkspace();
  const group = id ? ws.blocks[id]?.link : null;
  return useView((v) => (group ? (v.links[`${group}:${channel}`] as T) : undefined));
}

/** Publish `value` on `channel` to this block's link group: on change and whenever this block gains focus. */
export function useLinkPublish(channel: string, value: unknown) {
  const mux = useMux();
  const id = useContext(BlockIdContext);
  const ws = useWorkspace();
  const group = id ? ws.blocks[id]?.link : null;
  const focused = useView((v) => v.focused === id);
  const key = JSON.stringify(value);
  useEffect(() => {
    if (group && value !== undefined) mux.publishLink(group, channel, value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mux, group, channel, key, focused]);
}
