import type { ComponentType } from "react";

export interface BlockProps<S = Record<string, unknown>> {
  id: string;
  state: S;
}

export interface LaunchOption {
  label: string;
  state: Record<string, unknown>;
}

export interface BlockDef<S = any> {
  /** Reverse-DNS kind, e.g. "inspect.session". */
  kind: string;
  /** Shown in the launcher and as the fallback tab title. */
  name: string;
  title?: (state: S) => string;
  icon?: string;
  component: ComponentType<BlockProps<S>>;
  /** Choices offered by the launcher ("new block" picker). Omit to hide the kind from it. */
  launch?: () => LaunchOption[];
}

export interface BlockRegistry {
  get(kind: string): BlockDef | undefined;
  all(): BlockDef[];
}

export const defineBlock = <S,>(def: BlockDef<S>): BlockDef<S> => def;

export function createBlockRegistry(defs: BlockDef[]): BlockRegistry {
  const map = new Map(defs.map((d) => [d.kind, d]));
  return { get: (k) => map.get(k), all: () => [...map.values()] };
}
