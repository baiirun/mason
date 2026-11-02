// Stand-in for the Postgres side: module versions and heads, and the
// block_subscriptions topic index. One instance ("main"). Which blocks exist
// is the Canvas DO's job.
import { DurableObject } from "cloudflare:workers";
import type { Compiled } from "./compile";

export interface ModuleVersion {
  id: string;
  moduleId: string;
  commit: string;
  compiled: Compiled;
  manifest: { id: string; tools: string[]; queries: string[]; actions: string[] };
  createdAt: number;
}

export interface BlockRecord {
  id: string;
  moduleId: string;
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
  /** The module's current version: what blocks following head (and newly opened ones) run. */
  async setHead(moduleId: string, versionId: string) {
    await this.ctx.storage.put(`head:${moduleId}`, versionId);
  }
  async getHead(moduleId: string) {
    return (await this.ctx.storage.get<string>(`head:${moduleId}`)) ?? null;
  }
  /** Published modules and their current versions. */
  async listModules() {
    const heads = await this.ctx.storage.list<string>({ prefix: "head:" });
    return [...heads].map(([k, versionId]) => ({ module: k.slice(5), versionId }));
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
