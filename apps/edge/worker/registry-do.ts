// Stand-in for the Postgres side: module versions, block records and the
// block_subscriptions topic index. One instance ("main").
import { DurableObject } from "cloudflare:workers";
import type { Compiled } from "./compile";

export interface ModuleVersion {
  id: string;
  moduleId: string;
  compiled: Compiled;
  manifest: { id: string; tools: string[]; queries: string[]; actions: string[] };
  createdAt: number;
}

export interface BlockRecord {
  id: string;
  versionId: string;
  props: Record<string, unknown>;
  principal: string;
}

export class RegistryDO extends DurableObject {
  async putVersion(v: ModuleVersion) {
    await this.ctx.storage.put(`version:${v.id}`, v);
  }
  async getVersion(id: string) {
    return (await this.ctx.storage.get<ModuleVersion>(`version:${id}`)) ?? null;
  }
  async putBlock(b: BlockRecord) {
    await this.ctx.storage.put(`block:${b.id}`, b);
  }
  async getBlock(id: string) {
    return (await this.ctx.storage.get<BlockRecord>(`block:${id}`)) ?? null;
  }
  async listBlocks() {
    return [...(await this.ctx.storage.list<BlockRecord>({ prefix: "block:" })).values()];
  }

  /** Replace a block's topics: what `delete from block_subscriptions where block_id = $1; insert ...` would do. */
  async setSubscriptions(blockId: string, topics: string[]) {
    const old = (await this.ctx.storage.get<string[]>(`subs-of:${blockId}`)) ?? [];
    for (const t of old) await this.ctx.storage.delete(`sub:${t}:${blockId}`);
    for (const t of topics) await this.ctx.storage.put(`sub:${t}:${blockId}`, blockId);
    await this.ctx.storage.put(`subs-of:${blockId}`, topics);
  }

  /** `select block_id from block_subscriptions where topic = any($1)` */
  async lookup(topics: string[]) {
    const ids = new Set<string>();
    for (const t of topics) for (const id of (await this.ctx.storage.list<string>({ prefix: `sub:${t}:` })).values()) ids.add(id);
    return [...ids];
  }
}
