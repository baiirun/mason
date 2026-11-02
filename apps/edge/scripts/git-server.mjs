// Local stand-in for Cloudflare Artifacts: a bare git repo served over smart HTTP
// by `git http-backend`, plus the few read calls the Artifacts Workers binding
// offers (log, readFile, and a changed-paths diff). Only the edge Worker's git
// proxy talks to it; agents clone through the proxy.
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const APP = fileURLToPath(new URL("..", import.meta.url));
const ROOT = process.env.GIT_DATA ?? join(APP, ".git-data"); // override to run an isolated copy (e.g. for tests)
const PORT = Number(process.env.GIT_PORT ?? 8788);
const REPO = "workspace";

function git(args, opts = {}) {
  return execFileSync("git", args, { encoding: "utf8", ...opts });
}

function ensureRepo() {
  const bare = join(ROOT, `${REPO}.git`);
  if (existsSync(bare)) return;
  mkdirSync(ROOT, { recursive: true });
  git(["init", "--bare", "-q", "-b", "main", bare]);
  git(["--git-dir", bare, "config", "http.receivepack", "true"]);
  // Seed it with the example blocks, as an ordinary first commit.
  const work = mkdtempSync(join(tmpdir(), "mason-seed-"));
  cpSync(join(APP, "seed"), work, { recursive: true });
  const id = ["-c", "user.name=mason", "-c", "user.email=mason@localhost"];
  git(["init", "-q", "-b", "main"], { cwd: work });
  git(["add", "."], { cwd: work });
  git([...id, "commit", "-q", "-m", "Seed blocks"], { cwd: work });
  git(["push", "-q", bare, "main"], { cwd: work });
  rmSync(work, { recursive: true, force: true });
  console.log(`seeded ${bare}`);
}

/** Run git http-backend as CGI for one request. */
function cgi(req, res, pathInfo, query) {
  const env = {
    ...process.env,
    GIT_PROJECT_ROOT: ROOT,
    GIT_HTTP_EXPORT_ALL: "1",
    PATH_INFO: pathInfo,
    REQUEST_METHOD: req.method,
    QUERY_STRING: query,
    CONTENT_TYPE: req.headers["content-type"] ?? "",
    REMOTE_ADDR: "127.0.0.1",
    REMOTE_USER: "proxy",
  };
  if (req.headers["content-length"]) env.CONTENT_LENGTH = req.headers["content-length"];
  for (const [k, v] of Object.entries(req.headers)) env[`HTTP_${k.toUpperCase().replaceAll("-", "_")}`] = String(v);

  const child = spawn("git", ["http-backend"], { env });
  req.pipe(child.stdin);
  let head = Buffer.alloc(0);
  let started = false;
  child.stdout.on("data", (chunk) => {
    if (started) return void res.write(chunk);
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf("\r\n\r\n");
    if (end < 0) return;
    const headers = {};
    let status = 200;
    for (const line of head.subarray(0, end).toString().split("\r\n")) {
      const i = line.indexOf(":");
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim();
      if (k.toLowerCase() === "status") status = Number(v.split(" ")[0]);
      else headers[k] = v;
    }
    res.writeHead(status, headers);
    started = true;
    res.write(head.subarray(end + 4));
  });
  child.stdout.on("end", () => res.end());
  child.stderr.on("data", (d) => process.stderr.write(d));
}

/** The Artifacts-binding-shaped reads the Worker uses. */
function api(res, name, url) {
  const dir = join(ROOT, `${REPO}.git`);
  const g = (args) => git(["--git-dir", dir, ...args]);
  const send = (status, body, type = "application/json") => {
    res.writeHead(status, { "content-type": type });
    res.end(type === "application/json" ? JSON.stringify(body) : body);
  };
  try {
    if (name === "log") {
      const ref = url.searchParams.get("ref") ?? "main";
      const limit = url.searchParams.get("limit") ?? "1";
      const out = g(["log", `-n${limit}`, "--format=%H%x00%s", ref]).trim();
      return send(200, out ? out.split("\n").map((l) => ({ id: l.split("\0")[0], message: l.split("\0")[1] })) : []);
    }
    if (name === "file") {
      try {
        return send(200, g(["show", `${url.searchParams.get("ref")}:${url.searchParams.get("path")}`]), "text/plain");
      } catch {
        return send(404, "not found", "text/plain");
      }
    }
    if (name === "changed") {
      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to");
      const out = from ? g(["diff", "--name-only", from, to]) : g(["ls-tree", "-r", "--name-only", to]);
      return send(200, out.split("\n").filter(Boolean));
    }
    send(404, { error: "unknown call" });
  } catch (e) {
    send(500, { error: e.message });
  }
}

ensureRepo();
http
  .createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname.startsWith("/git/")) return cgi(req, res, url.pathname.slice(4), url.search.slice(1));
    const m = url.pathname.match(/^\/_api\/([\w-]+)\/(\w+)$/);
    if (m && m[1] === REPO) return api(res, m[2], url);
    res.writeHead(404).end();
  })
  .listen(PORT, () => console.log(`git stand-in on http://localhost:${PORT} (repo: ${REPO})`));
