import { applyOp, emptyWorkspace } from "./apply";
import type { Op, Workspace } from "./types";

export type ClientMsg =
  | { type: "hello"; clientId: string }
  | { type: "op"; clientOpId: string; op: Op };

export type ServerMsg =
  /** Sent on connect. `applied` lists this client's op ids the server already has. */
  | { type: "snapshot"; version: number; state: Workspace; applied: string[] }
  | { type: "op"; version: number; op: Op; clientId: string; clientOpId: string }
  | { type: "reject"; clientOpId: string; reason: string };

interface Pending {
  clientOpId: string;
  op: Op;
}

export interface SyncClientOptions {
  clientId: string;
  send: (msg: ClientMsg) => void;
  onReject?: (op: Op, reason: string) => void;
}

/**
 * Optimistic client for the server-owned workspace.
 *
 *   view = pending ops replayed on top of the last confirmed server state
 *
 * `dispatch` updates `view` immediately and sends the op. When the server
 * broadcasts ops (ours or anyone's) we advance `confirmed` and replay what's
 * still pending. Ops that no longer apply are skipped in the view and will be
 * rejected by the server. Nothing in the UI ever waits on a round trip.
 */
export class SyncClient {
  confirmed: Workspace = emptyWorkspace();
  version = -1;
  view: Workspace = this.confirmed;
  pending: Pending[] = [];
  connected = false;
  private listeners = new Set<() => void>();
  private seq = 0;

  constructor(private opts: SyncClientOptions) {}

  get ready() {
    return this.version >= 0;
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getState = () => this.view;

  /** Apply locally now, confirm with the server in the background. Returns false if the op is invalid. */
  dispatch(op: Op): boolean {
    try {
      this.view = applyOp(this.view, op);
    } catch {
      return false;
    }
    const p = { clientOpId: `${this.opts.clientId}:${++this.seq}`, op };
    this.pending.push(p);
    if (this.connected) this.opts.send({ type: "op", ...p });
    this.emit();
    return true;
  }

  /** Call when the transport (re)connects. */
  onOpen() {
    this.connected = true;
    this.opts.send({ type: "hello", clientId: this.opts.clientId });
  }

  onClose() {
    this.connected = false;
    this.emit();
  }

  receive(msg: ServerMsg) {
    switch (msg.type) {
      case "snapshot": {
        this.confirmed = msg.state;
        this.version = msg.version;
        // Drop ops the server already applied before we reconnected, resend the rest.
        const applied = new Set(msg.applied);
        this.pending = this.pending.filter((p) => !applied.has(p.clientOpId));
        for (const p of this.pending) this.opts.send({ type: "op", ...p });
        break;
      }
      case "op": {
        if (msg.version <= this.version) return;
        this.confirmed = applyOp(this.confirmed, msg.op);
        this.version = msg.version;
        if (msg.clientId === this.opts.clientId) {
          this.pending = this.pending.filter((p) => p.clientOpId !== msg.clientOpId);
        }
        break;
      }
      case "reject": {
        const p = this.pending.find((x) => x.clientOpId === msg.clientOpId);
        this.pending = this.pending.filter((x) => x.clientOpId !== msg.clientOpId);
        if (p && msg.reason !== "duplicate") this.opts.onReject?.(p.op, msg.reason);
        break;
      }
    }
    this.rebase();
    this.emit();
  }

  private rebase() {
    let view = this.confirmed;
    for (const p of this.pending) {
      try {
        view = applyOp(view, p.op);
      } catch {
        // Conflicts with something that happened on the server; it will be rejected.
      }
    }
    this.view = view;
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }
}

/** Authoritative side: sequence ops, reject invalid ones. Transport-agnostic. */
export class SyncServer {
  private appliedByClient = new Map<string, string[]>();

  constructor(
    public state: Workspace,
    public version = 0,
  ) {}

  snapshot(clientId: string): ServerMsg {
    return { type: "snapshot", version: this.version, state: this.state, applied: this.appliedByClient.get(clientId) ?? [] };
  }

  /** Returns the message to broadcast (op) or to send back to the sender (reject). */
  submit(clientId: string, clientOpId: string, op: Op): Extract<ServerMsg, { type: "op" | "reject" }> {
    const seen = this.appliedByClient.get(clientId) ?? [];
    if (seen.includes(clientOpId)) return { type: "reject", clientOpId, reason: "duplicate" };
    try {
      this.state = applyOp(this.state, op);
    } catch (e) {
      return { type: "reject", clientOpId, reason: (e as Error).message };
    }
    this.version++;
    seen.push(clientOpId);
    if (seen.length > 500) seen.splice(0, seen.length - 500);
    this.appliedByClient.set(clientId, seen);
    return { type: "op", version: this.version, op, clientId, clientOpId };
  }
}
