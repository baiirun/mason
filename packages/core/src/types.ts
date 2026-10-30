export type BlockId = string;
export type StackId = string;
export type SplitId = string;
export type SpaceId = string;

/** "row" lays children out left to right, "col" top to bottom. */
export type SplitDir = "row" | "col";
export type Edge = "left" | "right" | "up" | "down";

/** A block is one thing shown in the layout: a session, a doc, a preview... */
export interface BlockRecord {
  id: BlockId;
  /** Registered block kind, reverse-DNS style: "inspect.session". */
  kind: string;
  /** Serializable state owned by the block kind. References, not data. */
  state: Record<string, unknown>;
  /** Link group (e.g. "A"). Blocks in the same group share link values. */
  link?: string | null;
  /** Hidden from agents: left out of their context and tools. */
  hidden?: boolean;
}

/** A leaf of the layout tree: one or more blocks shown as tabs. */
export interface StackNode {
  type: "stack";
  id: StackId;
  blocks: BlockId[];
  active: BlockId;
}

export interface SplitNode {
  type: "split";
  id: SplitId;
  dir: SplitDir;
  children: LayoutNode[];
  /** Fractions that sum to 1, one per child. */
  sizes: number[];
}

export type LayoutNode = StackNode | SplitNode;

export interface Space {
  id: SpaceId;
  name: string;
  root: LayoutNode | null;
}

/** The whole shared, server-owned document. */
export interface Workspace {
  spaces: Space[];
  blocks: Record<BlockId, BlockRecord>;
}

/**
 * Where to put a block. `target` is a block id, a stack id, or "root" (the
 * whole space). Ids for any stack/split the op creates are chosen by the
 * caller so the op is deterministic and can be applied optimistically.
 */
export type Placement =
  | { mode: "tab"; target: BlockId | StackId; index?: number }
  | { mode: "split"; target: BlockId | StackId | "root"; edge: Edge; stackId: StackId; splitId: SplitId };

export type Op =
  | { type: "addSpace"; spaceId: SpaceId; name: string; index?: number; root?: LayoutNode | null; blocks?: BlockRecord[] }
  | { type: "renameSpace"; spaceId: SpaceId; name: string }
  | { type: "removeSpace"; spaceId: SpaceId }
  | { type: "openBlock"; spaceId: SpaceId; block: BlockRecord; at: Placement }
  | { type: "moveBlock"; blockId: BlockId; spaceId: SpaceId; at: Placement }
  | { type: "closeBlock"; blockId: BlockId }
  | { type: "setActive"; blockId: BlockId }
  | { type: "resize"; splitId: SplitId; sizes: number[] }
  | { type: "setBlockState"; blockId: BlockId; patch: Record<string, unknown> }
  | { type: "setLink"; blockId: BlockId; link: string | null }
  | { type: "setHidden"; blockId: BlockId; hidden: boolean }
  /** Swap what a block shows, keeping its place (e.g. a launcher turning into a session). */
  | { type: "replaceBlock"; blockId: BlockId; kind: string; state: Record<string, unknown> };

export class OpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpError";
  }
}
