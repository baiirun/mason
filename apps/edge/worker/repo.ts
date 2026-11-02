// Reads from a workspace's block repo, shaped like the Cloudflare Artifacts Workers
// binding (log, readFile) plus a changed-paths diff. Locally it calls the git
// stand-in (scripts/git-server.mjs); with real Artifacts this becomes env.ARTIFACTS.
import type { Env } from "./env";

export interface Repo {
  head(ref?: string): Promise<string | null>;
  readFile(ref: string, path: string): Promise<string | null>;
  changed(from: string | null, to: string): Promise<string[]>;
}

export function repo(env: Env, name: string): Repo {
  const base = `${env.GIT_UPSTREAM}/_api/${name}`;
  return {
    async head(ref = "main") {
      const res = await fetch(`${base}/log?ref=${encodeURIComponent(ref)}&limit=1`);
      if (!res.ok) return null;
      const log = await res.json<{ id: string }[]>();
      return log[0]?.id ?? null;
    },
    async readFile(ref, path) {
      const res = await fetch(`${base}/file?ref=${ref}&path=${encodeURIComponent(path)}`);
      return res.ok ? res.text() : null;
    },
    async changed(from, to) {
      const res = await fetch(`${base}/changed?${from ? `from=${from}&` : ""}to=${to}`);
      if (!res.ok) throw new Error(`diff failed: ${await res.text()}`);
      return res.json<string[]>();
    },
  };
}
