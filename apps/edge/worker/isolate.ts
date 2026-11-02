// Load a block's server bundle into its own Worker Loader isolate.
import ENTRY from "./isolate/entry.isolate.js";
import JSX from "./isolate/jsx.isolate.js";
import SDK from "./isolate/sdk.isolate.js";
import { sha256, type Bundle } from "./compile";
import type { Env } from "./env";

export function loadIsolate(env: Env, bundle: Bundle) {
  // The id is the bundle's hash, so the same id always means the same code and
  // the runtime can reuse a warm isolate.
  return env.LOADER.get(bundle.hex, async () => {
    const obj = await env.BUNDLES.get(bundle.key);
    if (!obj) throw new Error(`bundle ${bundle.key} missing`);
    const code = await obj.text();
    if ((await sha256(code)).hex !== bundle.hex) throw new Error("server bundle hash mismatch");
    return {
      compatibilityDate: "2026-10-01",
      mainModule: "entry.js",
      modules: { "entry.js": ENTRY, "mason-sdk.js": SDK, "mason-jsx.js": JSX, "block.js": code },
      env: {}, // no Hyperdrive, no R2, no secrets
      globalOutbound: null, // fetch() and connect() throw
    };
  }).getEntrypoint();
}
