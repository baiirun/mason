// Bundle the frame SDK (React + @mason/sdk view runtime) into one ES module that
// the worker serves at /runtime/sdk.js.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
await build({
  entryPoints: [`${root}/frame/sdk.tsx`],
  outfile: `${root}/worker/generated/frame-sdk.js`,
  bundle: true,
  format: "esm",
  jsx: "automatic",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "info",
});
