import type { BlockRecord, LayoutNode, Op } from "./types";

export const uid = (prefix = "") => `${prefix}${crypto.randomUUID().slice(0, 13)}`;

/** Layouts as code, Rex-style: row(0.4, block("doc"), col(block("session"), block("preview"))). */
export type Tpl =
  | { t: "block"; kind: string; state: Record<string, unknown>; tabs?: Tpl[]; link?: string }
  | { t: "split"; dir: "row" | "col"; sizes?: number[]; children: Tpl[] };

export const block = (kind: string, state: Record<string, unknown> = {}, opts: { link?: string } = {}): Tpl => ({
  t: "block",
  kind,
  state,
  ...opts,
});
/** Several blocks as tabs in one stack. */
export const tabs = (...blocks: Tpl[]): Tpl => ({ ...(blocks[0] as Extract<Tpl, { t: "block" }>), tabs: blocks.slice(1) });

function splitArgs(args: (number[] | Tpl)[]) {
  const sizes = Array.isArray(args[0]) ? (args.shift() as number[]) : undefined;
  return { sizes, children: args as Tpl[] };
}
export const row = (...args: (number[] | Tpl)[]): Tpl => ({ t: "split", dir: "row", ...splitArgs(args) });
export const col = (...args: (number[] | Tpl)[]): Tpl => ({ t: "split", dir: "col", ...splitArgs(args) });

/** Compile a template to an addSpace op with fresh ids. */
export function spaceFromTemplate(name: string, tpl: Tpl, spaceId = uid("space-")): Extract<Op, { type: "addSpace" }> {
  const blocks: BlockRecord[] = [];
  const mk = (b: Extract<Tpl, { t: "block" }>): BlockRecord => {
    const rec: BlockRecord = { id: uid("block-"), kind: b.kind, state: b.state, link: b.link ?? null };
    blocks.push(rec);
    return rec;
  };
  const build = (n: Tpl): LayoutNode => {
    if (n.t === "block") {
      const ids = [n, ...(n.tabs ?? [])].map((b) => mk(b as Extract<Tpl, { t: "block" }>).id);
      return { type: "stack", id: uid("stack-"), blocks: ids, active: ids[0]! };
    }
    const children = n.children.map(build);
    return { type: "split", id: uid("split-"), dir: n.dir, children, sizes: n.sizes ?? children.map(() => 1 / children.length) };
  };
  return { type: "addSpace", spaceId, name, root: build(tpl), blocks };
}
