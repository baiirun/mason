import { describe, expect, it } from "vitest";
import {
  applyOp,
  blocksIn,
  col,
  block,
  emptyWorkspace,
  pickDirectional,
  row,
  spaceFromTemplate,
  SyncClient,
  SyncServer,
  type ClientMsg,
  type LayoutNode,
  type Op,
  type ServerMsg,
  type Workspace,
} from "../src";

const b = (id: string, kind = "test") => ({ id, kind, state: {} });

function shape(n: LayoutNode | null): unknown {
  if (!n) return null;
  if (n.type === "stack") return n.blocks.join("+");
  return { [n.dir]: n.children.map(shape), sizes: n.sizes.map((s) => Math.round(s * 100) / 100) };
}

function base(): Workspace {
  let ws = applyOp(emptyWorkspace(), { type: "addSpace", spaceId: "s", name: "Main" });
  ws = applyOp(ws, { type: "openBlock", spaceId: "s", block: b("a"), at: { mode: "split", target: "root", edge: "right", stackId: "st-a", splitId: "x0" } });
  return ws;
}
const split = (target: string, edge: "left" | "right" | "up" | "down", id: string): Op => ({
  type: "openBlock",
  spaceId: "s",
  block: b(id),
  at: { mode: "split", target, edge, stackId: `st-${id}`, splitId: `sp-${id}` },
});
const root = (ws: Workspace) => ws.spaces[0]!.root;

describe("layout ops", () => {
  it("splits, and merges same-direction splits into an n-ary row", () => {
    let ws = applyOp(base(), split("a", "right", "b"));
    ws = applyOp(ws, split("b", "right", "c"));
    expect(shape(root(ws))).toEqual({ row: ["a", "b", "c"], sizes: [0.5, 0.25, 0.25] });
  });

  it("nests perpendicular splits", () => {
    let ws = applyOp(base(), split("a", "right", "b"));
    ws = applyOp(ws, split("b", "down", "c"));
    expect(shape(root(ws))).toEqual({ row: ["a", { col: ["b", "c"], sizes: [0.5, 0.5] }], sizes: [0.5, 0.5] });
  });

  it("collapses splits on close", () => {
    let ws = applyOp(base(), split("a", "right", "b"));
    ws = applyOp(ws, split("b", "down", "c"));
    ws = applyOp(ws, { type: "closeBlock", blockId: "c" });
    expect(shape(root(ws))).toEqual({ row: ["a", "b"], sizes: [0.5, 0.5] });
    ws = applyOp(ws, { type: "closeBlock", blockId: "a" });
    expect(shape(root(ws))).toEqual("b");
    expect(Object.keys(ws.blocks)).toEqual(["b"]);
  });

  it("adds tabs and moves blocks between stacks and spaces", () => {
    let ws = applyOp(base(), split("a", "right", "b"));
    ws = applyOp(ws, { type: "openBlock", spaceId: "s", block: b("t"), at: { mode: "tab", target: "a" } });
    expect(shape(root(ws))).toEqual({ row: ["a+t", "b"], sizes: [0.5, 0.5] });
    ws = applyOp(ws, { type: "moveBlock", blockId: "t", spaceId: "s", at: { mode: "split", target: "b", edge: "down", stackId: "n1", splitId: "n2" } });
    expect(shape(root(ws))).toEqual({ row: ["a", { col: ["b", "t"], sizes: [0.5, 0.5] }], sizes: [0.5, 0.5] });
    ws = applyOp(ws, { type: "addSpace", spaceId: "s2", name: "Two" });
    ws = applyOp(ws, { type: "moveBlock", blockId: "t", spaceId: "s2", at: { mode: "split", target: "root", edge: "right", stackId: "n3", splitId: "n4" } });
    expect(blocksIn(ws.spaces[1]!.root)).toEqual(["t"]);
    expect(shape(root(ws))).toEqual({ row: ["a", "b"], sizes: [0.5, 0.5] });
  });

  it("rejects nonsense", () => {
    expect(() => applyOp(base(), { type: "closeBlock", blockId: "nope" })).toThrow();
    expect(() => applyOp(base(), { type: "moveBlock", blockId: "a", spaceId: "s", at: { mode: "split", target: "a", edge: "left", stackId: "1", splitId: "2" } })).toThrow();
  });

  it("compiles layout templates", () => {
    const op = spaceFromTemplate("Review", row([0.4, 0.6], block("doc"), col(block("session"), block("preview"))), "r");
    const ws = applyOp(emptyWorkspace(), op);
    expect(ws.spaces[0]!.root!.type).toBe("split");
    expect(Object.values(ws.blocks).map((x) => x.kind)).toEqual(["doc", "session", "preview"]);
  });
});

describe("geometry", () => {
  it("picks the overlapping neighbour", () => {
    const a = { id: "a", rect: { x: 0, y: 0, w: 100, h: 200 } };
    const b = { id: "b", rect: { x: 100, y: 0, w: 100, h: 100 } };
    const c = { id: "c", rect: { x: 100, y: 100, w: 100, h: 100 } };
    expect(pickDirectional([a, b, c], c.rect, "left")?.id).toBe("a");
    expect(pickDirectional([a, b, c], b.rect, "down")?.id).toBe("c");
    expect(pickDirectional([a, b, c], a.rect, "left")).toBeUndefined();
  });
});

describe("optimistic sync", () => {
  function setup() {
    const server = new SyncServer(base());
    const clients: SyncClient[] = [];
    const outbox: [SyncClient, string, ClientMsg][] = [];
    const broadcast = (m: ServerMsg) => clients.forEach((c) => c.receive(m));
    const mk = (id: string) => {
      const c: SyncClient = new SyncClient({ clientId: id, send: (m) => outbox.push([c, id, m]) });
      clients.push(c);
      c.onOpen();
      return c;
    };
    const flush = () => {
      while (outbox.length) {
        const [c, id, m] = outbox.shift()!;
        if (m.type === "hello") c.receive(server.snapshot(id));
        else {
          const res = server.submit(id, m.clientOpId, m.op);
          if (res.type === "op") broadcast(res);
          else c.receive(res);
        }
      }
    };
    return { server, mk, flush };
  }

  it("applies locally before the server confirms, then converges", () => {
    const { server, mk, flush } = setup();
    const c1 = mk("c1");
    const c2 = mk("c2");
    flush();
    c1.dispatch(split("a", "right", "b"));
    expect(blocksIn(root(c1.view))).toEqual(["a", "b"]); // instant
    expect(blocksIn(root(c2.view))).toEqual(["a"]);
    flush();
    expect(c1.pending).toHaveLength(0);
    expect(c2.view).toEqual(server.state);
    expect(c1.view).toEqual(server.state);
  });

  it("rebases pending ops over concurrent ones and drops conflicts", () => {
    const { server, mk, flush } = setup();
    const c1 = mk("c1");
    const c2 = mk("c2");
    flush();
    c1.dispatch(split("a", "right", "b"));
    flush();
    // Concurrently: c1 tabs into b, c2 closes b.
    const rejected: string[] = [];
    (c1 as any).opts.onReject = (_: Op, r: string) => rejected.push(r);
    c2.dispatch({ type: "closeBlock", blockId: "b" });
    c1.dispatch({ type: "openBlock", spaceId: "s", block: b("t"), at: { mode: "tab", target: "b" } });
    flush();
    expect(rejected).toHaveLength(1);
    expect(c1.view).toEqual(server.state);
    expect(c2.view).toEqual(server.state);
  });

  it("resends unacked ops on reconnect without duplicating", () => {
    const { server, mk, flush } = setup();
    const c1 = mk("c1");
    flush();
    c1.onClose();
    c1.dispatch(split("a", "right", "b"));
    c1.onOpen();
    flush();
    expect(blocksIn(root(server.state))).toEqual(["a", "b"]);
    expect(c1.pending).toHaveLength(0);
  });
});
