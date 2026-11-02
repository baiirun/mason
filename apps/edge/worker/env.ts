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
