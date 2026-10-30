import type { BlockId, Edge, LayoutNode, Placement, SplitDir, SplitNode, StackNode } from "./types";
import { OpError } from "./types";

export const edgeDir = (edge: Edge): SplitDir => (edge === "left" || edge === "right" ? "row" : "col");
const before = (edge: Edge) => edge === "left" || edge === "up";

export function* stacks(node: LayoutNode | null): Generator<StackNode> {
  if (!node) return;
  if (node.type === "stack") yield node;
  else for (const c of node.children) yield* stacks(c);
}

export function findStack(node: LayoutNode | null, target: string): StackNode | undefined {
  for (const s of stacks(node)) if (s.id === target || s.blocks.includes(target)) return s;
  return undefined;
}

export function findSplit(node: LayoutNode | null, id: string): SplitNode | undefined {
  if (!node || node.type === "stack") return undefined;
  if (node.id === id) return node;
  for (const c of node.children) {
    const found = findSplit(c, id);
    if (found) return found;
  }
  return undefined;
}

export function blocksIn(node: LayoutNode | null): BlockId[] {
  return [...stacks(node)].flatMap((s) => s.blocks);
}

/** Replace nodes bottom-up. `fn` returns the replacement (or null to remove). */
function mapNode(node: LayoutNode, fn: (n: LayoutNode) => LayoutNode | null): LayoutNode | null {
  if (node.type === "split") {
    const kept: LayoutNode[] = [];
    const sizes: number[] = [];
    node.children.forEach((c, i) => {
      const next = mapNode(c, fn);
      if (next) {
        kept.push(next);
        sizes.push(node.sizes[i] ?? 0);
      }
    });
    return fn({ ...node, children: kept, sizes });
  }
  return fn(node);
}

const normalizeSizes = (sizes: number[]) => {
  const total = sizes.reduce((a, b) => a + b, 0);
  return total > 0 ? sizes.map((s) => s / total) : sizes.map(() => 1 / sizes.length);
};

/** Collapse empty/single-child splits and merge splits with their same-direction parent. */
export function normalize(node: LayoutNode | null): LayoutNode | null {
  if (!node) return null;
  return mapNode(node, (n) => {
    if (n.type === "stack") return n.blocks.length ? n : null;
    if (n.children.length === 0) return null;
    if (n.children.length === 1) return n.children[0]!;
    const children: LayoutNode[] = [];
    const sizes: number[] = [];
    n.children.forEach((c, i) => {
      const size = n.sizes[i]!;
      if (c.type === "split" && c.dir === n.dir) {
        c.children.forEach((gc, j) => {
          children.push(gc);
          sizes.push(size * c.sizes[j]!);
        });
      } else {
        children.push(c);
        sizes.push(size);
      }
    });
    return { ...n, children, sizes: normalizeSizes(sizes) };
  });
}

export function removeBlock(root: LayoutNode | null, blockId: BlockId): LayoutNode | null {
  if (!root) return null;
  const next = mapNode(root, (n) => {
    if (n.type !== "stack" || !n.blocks.includes(blockId)) return n;
    const idx = n.blocks.indexOf(blockId);
    const blocks = n.blocks.filter((b) => b !== blockId);
    const active = n.active === blockId ? (blocks[Math.min(idx, blocks.length - 1)] ?? "") : n.active;
    return { ...n, blocks, active };
  });
  return normalize(next);
}

/** Insert `blockId` (already removed from the tree, if it was in it) at `at`. */
export function insertBlock(root: LayoutNode | null, blockId: BlockId, at: Placement): LayoutNode {
  if (at.mode === "tab") {
    const stack = findStack(root, at.target);
    if (!stack || !root) throw new OpError(`tab target ${at.target} not found`);
    const next = mapNode(root, (n) => {
      if (n !== stack) return n;
      const blocks = [...stack.blocks];
      const idx = at.index ?? (stack.blocks.includes(at.target) ? blocks.indexOf(at.target) + 1 : blocks.length);
      blocks.splice(Math.max(0, Math.min(idx, blocks.length)), 0, blockId);
      return { ...stack, blocks, active: blockId };
    });
    return next!;
  }

  const fresh: StackNode = { type: "stack", id: at.stackId, blocks: [blockId], active: blockId };
  const dir = edgeDir(at.edge);
  const wrap = (node: LayoutNode): SplitNode => ({
    type: "split",
    id: at.splitId,
    dir,
    children: before(at.edge) ? [fresh, node] : [node, fresh],
    sizes: [0.5, 0.5],
  });

  if (at.target === "root") {
    if (!root) return fresh;
    if (root.type === "split" && root.dir === dir) {
      const n = root.children.length;
      const share = 1 / (n + 1);
      const scaled = root.sizes.map((s) => s * (1 - share));
      return before(at.edge)
        ? { ...root, children: [fresh, ...root.children], sizes: [share, ...scaled] }
        : { ...root, children: [...root.children, fresh], sizes: [...scaled, share] };
    }
    return wrap(root);
  }

  const stack = findStack(root, at.target);
  if (!stack || !root) throw new OpError(`split target ${at.target} not found`);
  // Wrap the target stack in a split; normalize() merges it into a same-direction parent.
  const next = mapNode(root, (n) => (n === stack ? wrap(n) : n));
  return normalize(next)!;
}
