// Compile one block module (a single TSX file with `export default Block.define(...)`)
// into a server bundle (for the Worker Loader isolate) and a client bundle (for the
// view iframe). Both are content-addressed; only this code writes to BUNDLES.
import { transform } from "sucrase";

const ALLOWED_IMPORTS = new Set(["@mason/sdk", "@mason/sdk/jsx-runtime"]);
const SECRET_PATTERNS = [/gh[pousr]_[A-Za-z0-9]{20,}/, /xox[abpr]-[A-Za-z0-9-]{10,}/, /sk-[A-Za-z0-9]{20,}/];

export interface Bundle {
  hex: string; // sha256, hex: R2 key and Worker Loader id
  sri: string; // sha256, base64: <script integrity>
  key: string;
}

export interface Compiled {
  server: Bundle;
  client: Bundle;
}

export class CompileError extends Error {}

export async function sha256(text: string) {
  const buf = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  const hex = [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
  let bin = "";
  for (const b of buf) bin += String.fromCharCode(b);
  return { hex, sri: `sha256-${btoa(bin)}` };
}

export async function compile(source: string, bundles: R2Bucket): Promise<Compiled> {
  for (const re of SECRET_PATTERNS) if (re.test(source)) throw new CompileError("source looks like it contains a token; credentials come from the gateway");

  let code: string;
  try {
    code = transform(source, {
      transforms: ["typescript", "jsx"],
      jsxRuntime: "automatic",
      jsxImportSource: "@mason/sdk",
      production: true,
    }).code;
  } catch (e: any) {
    throw new CompileError(e.message);
  }

  if (/\bimport\s*\(/.test(code)) throw new CompileError("dynamic import() is not allowed");
  for (const m of code.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)) {
    if (!ALLOWED_IMPORTS.has(m[1]!)) throw new CompileError(`import "${m[1]}" is not allowed (allowed: ${[...ALLOWED_IMPORTS].join(", ")})`);
  }

  // Server: the isolate names its sibling modules by relative path.
  const serverCode = code
    .replaceAll(`"@mason/sdk/jsx-runtime"`, `"./mason-jsx.js"`)
    .replaceAll(`"@mason/sdk"`, `"./mason-sdk.js"`);
  // Client: bare specifiers resolve through the frame's import map.
  const clientCode = code;

  const put = async (kind: string, text: string): Promise<Bundle> => {
    const h = await sha256(text);
    const key = `bundles/${kind}/${h.hex}.js`;
    await bundles.put(key, text, { httpMetadata: { contentType: "text/javascript" } });
    return { ...h, key };
  };
  return { server: await put("server", serverCode), client: await put("client", clientCode) };
}
