import type { BlockDO } from "./block-do";
import type { CanvasDO } from "./canvas-do";
import type { GatewayDO } from "./gateway-do";
import type { RegistryDO } from "./registry-do";

export interface Env {
  LOADER: any; // Worker Loader binding
  BUNDLES: R2Bucket;
  BLOCK: DurableObjectNamespace<BlockDO>;
  CANVAS: DurableObjectNamespace<CanvasDO>;
  REGISTRY: DurableObjectNamespace<RegistryDO>;
  GATEWAY: DurableObjectNamespace<GatewayDO>;
  FRAME_ORIGIN: string;
  APP_ORIGIN: string;
  GIT_UPSTREAM: string;
  GIT_TOKEN: string;
}

export const registry = (env: Env) => env.REGISTRY.get(env.REGISTRY.idFromName("main"));
export const gateway = (env: Env) => env.GATEWAY.get(env.GATEWAY.idFromName("main"));
export const blockStub = (env: Env, id: string) => env.BLOCK.get(env.BLOCK.idFromName(id));
export const canvas = (env: Env, workspace = "workspace") => env.CANVAS.get(env.CANVAS.idFromName(workspace));

/** Webhook fan-out: topic index lookup, then wake each subscribed Block DO. */
export async function fanout(env: Env, topics: string[], exceptBlockId?: string) {
  if (!topics.length) return [];
  const ids = (await registry(env).lookup(topics)).filter((id) => id !== exceptBlockId);
  await Promise.all(ids.map((id) => blockStub(env, id).notify(topics)));
  return ids;
}
