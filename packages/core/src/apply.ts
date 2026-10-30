import { blocksIn, findSplit, findStack, insertBlock, normalize, removeBlock } from "./tree";
import type { LayoutNode, Op, Space, Workspace } from "./types";
import { OpError } from "./types";

export const emptyWorkspace = (): Workspace => ({ spaces: [], blocks: {} });

export function spaceOfBlock(ws: Workspace, blockId: string): Space | undefined {
  return ws.spaces.find((s) => findStack(s.root, blockId));
}

function getSpace(ws: Workspace, spaceId: string): Space {
  const space = ws.spaces.find((s) => s.id === spaceId);
  if (!space) throw new OpError(`space ${spaceId} not found`);
  return space;
}

function setRoot(ws: Workspace, spaceId: string, root: LayoutNode | null): Workspace {
  return { ...ws, spaces: ws.spaces.map((s) => (s.id === spaceId ? { ...s, root } : s)) };
}

function mapStacks(root: LayoutNode | null, fn: (n: LayoutNode) => LayoutNode): LayoutNode | null {
  if (!root) return null;
  if (root.type === "stack") return fn(root);
  return fn({ ...root, children: root.children.map((c) => mapStacks(c, fn)!) });
}

/**
 * Apply one op. Pure and deterministic: the server and every client run the
 * same function, which is what makes optimistic updates safe. Throws OpError
 * when the op doesn't make sense against `ws` (the server rejects it, clients
 * drop it while rebasing).
 */
export function applyOp(ws: Workspace, op: Op): Workspace {
  switch (op.type) {
    case "addSpace": {
      if (ws.spaces.some((s) => s.id === op.spaceId)) throw new OpError(`space ${op.spaceId} exists`);
      const spaces = [...ws.spaces];
      spaces.splice(op.index ?? spaces.length, 0, { id: op.spaceId, name: op.name, root: normalize(op.root ?? null) });
      const blocks = { ...ws.blocks };
      for (const b of op.blocks ?? []) blocks[b.id] = b;
      return { spaces, blocks };
    }
    case "renameSpace":
      getSpace(ws, op.spaceId);
      return { ...ws, spaces: ws.spaces.map((s) => (s.id === op.spaceId ? { ...s, name: op.name } : s)) };
    case "removeSpace": {
      const space = getSpace(ws, op.spaceId);
      const blocks = { ...ws.blocks };
      for (const id of blocksIn(space.root)) delete blocks[id];
      return { spaces: ws.spaces.filter((s) => s.id !== op.spaceId), blocks };
    }
    case "openBlock": {
      if (ws.blocks[op.block.id]) throw new OpError(`block ${op.block.id} exists`);
      const space = getSpace(ws, op.spaceId);
      const root = insertBlock(space.root, op.block.id, op.at);
      return { ...setRoot(ws, op.spaceId, root), blocks: { ...ws.blocks, [op.block.id]: op.block } };
    }
    case "moveBlock": {
      const from = spaceOfBlock(ws, op.blockId);
      if (!from) throw new OpError(`block ${op.blockId} not found`);
      if (op.at.target === op.blockId) throw new OpError("cannot place a block relative to itself");
      let next = setRoot(ws, from.id, removeBlock(from.root, op.blockId));
      const to = getSpace(next, op.spaceId);
      next = setRoot(next, op.spaceId, insertBlock(to.root, op.blockId, op.at));
      return next;
    }
    case "closeBlock": {
      const space = spaceOfBlock(ws, op.blockId);
      if (!space) throw new OpError(`block ${op.blockId} not found`);
      const blocks = { ...ws.blocks };
      delete blocks[op.blockId];
      return { ...setRoot(ws, space.id, removeBlock(space.root, op.blockId)), blocks };
    }
    case "setActive": {
      const space = spaceOfBlock(ws, op.blockId);
      if (!space) throw new OpError(`block ${op.blockId} not found`);
      const root = mapStacks(space.root, (n) =>
        n.type === "stack" && n.blocks.includes(op.blockId) ? { ...n, active: op.blockId } : n,
      );
      return setRoot(ws, space.id, root);
    }
    case "resize": {
      const space = ws.spaces.find((s) => findSplit(s.root, op.splitId));
      const split = space && findSplit(space.root, op.splitId);
      if (!space || !split) throw new OpError(`split ${op.splitId} not found`);
      if (op.sizes.length !== split.children.length) throw new OpError("size count mismatch");
      const total = op.sizes.reduce((a, b) => a + b, 0);
      const sizes = op.sizes.map((s) => s / total);
      const root = mapStacks(space.root, (n) => (n.type === "split" && n.id === op.splitId ? { ...n, sizes } : n));
      return setRoot(ws, space.id, root);
    }
    case "setBlockState": {
      const block = ws.blocks[op.blockId];
      if (!block) throw new OpError(`block ${op.blockId} not found`);
      return { ...ws, blocks: { ...ws.blocks, [op.blockId]: { ...block, state: { ...block.state, ...op.patch } } } };
    }
    case "setLink": {
      const block = ws.blocks[op.blockId];
      if (!block) throw new OpError(`block ${op.blockId} not found`);
      return { ...ws, blocks: { ...ws.blocks, [op.blockId]: { ...block, link: op.link } } };
    }
    case "setHidden": {
      const block = ws.blocks[op.blockId];
      if (!block) throw new OpError(`block ${op.blockId} not found`);
      return { ...ws, blocks: { ...ws.blocks, [op.blockId]: { ...block, hidden: op.hidden } } };
    }
    case "replaceBlock": {
      const block = ws.blocks[op.blockId];
      if (!block) throw new OpError(`block ${op.blockId} not found`);
      return { ...ws, blocks: { ...ws.blocks, [op.blockId]: { ...block, kind: op.kind, state: op.state } } };
    }
  }
}
