// The canvas: which blocks exist and where they sit. Server-owned and changed
// only through ops (open, move, resize, setProps, close), the same path for the
// UI and for agents. Block *code* lives in git; this never touches it. Each
// instance points at a module and either follows its head or pins a version.
//
// In production this state would also be persisted to Postgres; here DO storage is it.
import { DurableObject } from "cloudflare:workers";
import { blockStub, registry, type Env } from "./env";
import type { BlockRecord } from "./registry-do";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Instance {
  id: string;
  module: string;
  /** "head" follows the module's latest published version; otherwise a pinned version id. */
  version: "head" | { pinned: string };
  versionId: string;
  props: Record<string, unknown>;
  rect: Rect;
  z: number;
  principal: string;
}

export type CanvasOp =
  | { type: "open"; id?: string; module: string; props?: Record<string, unknown>; rect?: Partial<Rect>; near?: string; pin?: boolean }
  | { type: "move"; id: string; x: number; y: number }
  | { type: "resize"; id: string; w: number; h: number }
  | { type: "raise"; id: string }
  | { type: "setProps"; id: string; props: Record<string, unknown> }
  | { type: "close"; id: string };

export class OpError extends Error {}

const GAP = 16;
const DEFAULT_SIZE = { w: 640, h: 420 };
const MIN_SIZE = { w: 240, h: 140 };
const LOG_SIZE = 200;
const ROW_WIDTH = 1360; // auto-placement wraps to a new row past this

const rec = (b: Instance): BlockRecord => ({ id: b.id, moduleId: b.module, versionId: b.versionId, props: b.props, principal: b.principal });

export class CanvasDO extends DurableObject<Env> {
  private blocks: Record<string, Instance> = {};
  private seq = 0;
  private log: { seq: number; op: CanvasOp; actor: string }[] = [];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.blocks = (await ctx.storage.get<Record<string, Instance>>("blocks")) ?? {};
      this.seq = (await ctx.storage.get<number>("seq")) ?? 0;
    });
  }

  private async save() {
    await this.ctx.storage.put({ blocks: this.blocks, seq: this.seq });
  }

  private broadcast(msg: unknown) {
    const text = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(text);
      } catch {}
    }
  }

  /** Everything a viewer needs, including each block's current client bundle. */
  async snapshot() {
    const reg = registry(this.env);
    const blocks = await Promise.all(
      Object.values(this.blocks).map(async (b) => {
        const v = await reg.getVersion(b.versionId);
        return { ...b, client: v ? { hex: v.compiled.client.hex, sri: v.compiled.client.sri } : null };
      }),
    );
    return { type: "snapshot", seq: this.seq, blocks };
  }

  /** Next to `near`, else to the right of the newest block if it fits, else a new row. */
  private place(near: Instance | undefined, size: { w: number; h: number }): Rect {
    if (near) return { x: near.rect.x + near.rect.w + GAP, y: near.rect.y, ...size };
    const all = Object.values(this.blocks);
    if (!all.length) return { x: GAP, y: GAP, ...size };
    const last = all.reduce((a, b) => (b.z > a.z ? b : a));
    if (last.rect.x + last.rect.w + GAP + size.w <= ROW_WIDTH) return { x: last.rect.x + last.rect.w + GAP, y: last.rect.y, ...size };
    const bottom = Math.max(...all.map((b) => b.rect.y + b.rect.h));
    return { x: GAP, y: bottom + GAP, ...size };
  }

  private need(id: string) {
    const b = this.blocks[id];
    if (!b) throw new OpError(`no block ${id}`);
    return b;
  }

  /** Apply one op. Validates, persists, tells the affected Block DO, then broadcasts. */
  async apply(op: CanvasOp, actor = "user:byron") {
    const reg = registry(this.env);
    let result: CanvasOp = op;
    switch (op.type) {
      case "open": {
        const head = await reg.getHead(op.module);
        if (!head) throw new OpError(`module ${op.module} has no published version; push blocks/${op.module}.tsx first`);
        const id = op.id ?? `${op.module}-${crypto.randomUUID().slice(0, 6)}`;
        if (this.blocks[id]) throw new OpError(`block ${id} already exists`);
        const near = op.near ? this.need(op.near) : undefined;
        const size = { w: op.rect?.w ?? DEFAULT_SIZE.w, h: op.rect?.h ?? DEFAULT_SIZE.h };
        const placed = this.place(near, size);
        const rect = { x: op.rect?.x ?? placed.x, y: op.rect?.y ?? placed.y, ...size };
        const z = Math.max(0, ...Object.values(this.blocks).map((b) => b.z)) + 1;
        const b: Instance = { id, module: op.module, version: op.pin ? { pinned: head } : "head", versionId: head, props: op.props ?? {}, rect, z, principal: actor };
        await blockStub(this.env, id).init(rec(b));
        this.blocks[id] = b;
        result = { ...op, id, rect };
        break;
      }
      case "move": {
        const b = this.need(op.id);
        b.rect = { ...b.rect, x: Math.max(0, Math.round(op.x)), y: Math.max(0, Math.round(op.y)) };
        break;
      }
      case "resize": {
        const b = this.need(op.id);
        b.rect = { ...b.rect, w: Math.max(MIN_SIZE.w, Math.round(op.w)), h: Math.max(MIN_SIZE.h, Math.round(op.h)) };
        break;
      }
      case "raise": {
        const b = this.need(op.id);
        b.z = Math.max(0, ...Object.values(this.blocks).map((x) => x.z)) + 1;
        break;
      }
      case "setProps": {
        const b = this.need(op.id);
        b.props = op.props;
        await blockStub(this.env, b.id).update(rec(b));
        break;
      }
      case "close": {
        this.need(op.id);
        delete this.blocks[op.id];
        await reg.setSubscriptions(op.id, []);
        await blockStub(this.env, op.id).destroy();
        break;
      }
      default:
        throw new OpError(`unknown op ${(op as any).type}`);
    }
    this.seq++;
    this.log.push({ seq: this.seq, op: result, actor });
    if (this.log.length > LOG_SIZE) this.log.shift();
    await this.save();
    const block = "id" in result && result.id ? this.blocks[result.id] : undefined;
    const client = block ? await this.clientFor(block) : null;
    this.broadcast({ type: "op", seq: this.seq, op: result, actor, block: block && { ...block, client } });
    return { seq: this.seq, op: result, block };
  }

  private async clientFor(b: Instance) {
    const v = await registry(this.env).getVersion(b.versionId);
    return v ? { hex: v.compiled.client.hex, sri: v.compiled.client.sri } : null;
  }

  /** A push published a module: move every instance following its head to the new version. */
  async moduleUpdated(module: string, versionId: string) {
    const moved: string[] = [];
    for (const b of Object.values(this.blocks)) {
      if (b.module !== module || b.version !== "head" || b.versionId === versionId) continue;
      b.versionId = versionId;
      await blockStub(this.env, b.id).update(rec(b));
      moved.push(b.id);
    }
    if (moved.length) {
      this.seq++;
      await this.save();
      for (const id of moved) {
        const block = this.blocks[id]!;
        this.broadcast({ type: "version", seq: this.seq, id, versionId, block: { ...block, client: await this.clientFor(block) } });
      }
    }
    const pinned = Object.values(this.blocks).filter((b) => b.module === module && b.version !== "head").map((b) => b.id);
    return { moved, pinned };
  }

  async list() {
    return Object.values(this.blocks);
  }

  // ---- viewers ---------------------------------------------------------------

  async fetch(req: Request) {
    if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].send(JSON.stringify(await this.snapshot()));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    const msg = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data));
    if (msg.type !== "op") return;
    try {
      const res = await this.apply(msg.op, "user:byron");
      ws.send(JSON.stringify({ type: "ack", id: msg.id, ok: true, seq: res.seq }));
    } catch (e: any) {
      ws.send(JSON.stringify({ type: "ack", id: msg.id, ok: false, error: e.message }));
    }
  }

  async webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code, "closing");
    } catch {}
  }
}
