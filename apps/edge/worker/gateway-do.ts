// Stand-in for the central MCP gateway plus the upstream services behind it:
// a fake GitHub (PRs per repo) and a fake Datadog (a p95 metric that only polls).
// It checks every call against the block grant, like the real gateway would.
import { DurableObject } from "cloudflare:workers";

export interface Grant {
  blockId: string;
  principal: string;
  tools: string[];
}

export interface Pr {
  id: number;
  number: number;
  repo: string;
  title: string;
  author: string;
  reviewers: string[];
  ci: "passing" | "failing" | "pending";
  state: "open" | "closed";
  updatedAt: number;
}

const SEED: Omit<Pr, "id" | "updatedAt">[] = [
  { number: 12, repo: "inspect/web", title: "Canvas zoom to fit", author: "maya", reviewers: ["byron"], ci: "passing", state: "open" },
  { number: 13, repo: "inspect/web", title: "Block iframe sandbox", author: "byron", reviewers: ["maya"], ci: "pending", state: "open" },
  { number: 15, repo: "inspect/web", title: "Fix link group colors", author: "sam", reviewers: ["byron", "maya"], ci: "failing", state: "open" },
  { number: 7, repo: "inspect/api", title: "MCP gateway grants", author: "sam", reviewers: ["byron"], ci: "passing", state: "open" },
  { number: 8, repo: "inspect/api", title: "Webhook ingress queue", author: "maya", reviewers: ["sam"], ci: "passing", state: "open" },
];

/** Topics an upstream change touches; the same strings queries register for. */
export const prTopics = (repo: string) => [`github:repo:${repo}:pulls`];

/** Topics a cached tool call should subscribe to. Sources with no push return none (they poll). */
export function topicsFor(tool: string, args: any): string[] {
  if (tool === "github.list_pull_requests" && args?.repo) return prTopics(args.repo);
  return [];
}

export class GatewayDO extends DurableObject {
  private async prs(): Promise<Pr[]> {
    let prs = await this.ctx.storage.get<Pr[]>("prs");
    if (!prs) {
      prs = SEED.map((p, i) => ({ ...p, id: 1000 + i, updatedAt: Date.now() }));
      await this.ctx.storage.put("prs", prs);
    }
    return prs;
  }

  /** One MCP tools/call, as the gateway would proxy it. Returns rows or a value. */
  async call(grant: Grant, tool: string, args: any): Promise<{ result: unknown; topics: string[] }> {
    if (!grant.tools.includes(tool)) throw new Error(`${tool} is not allowed by block ${grant.blockId}'s grant`);
    switch (tool) {
      case "github.list_pull_requests": {
        const rows = (await this.prs()).filter((p) => p.repo === args.repo && (!args.state || p.state === args.state));
        return { result: rows, topics: [] };
      }
      case "github.close_pull_request": {
        const prs = await this.prs();
        const pr = prs.find((p) => p.repo === args.repo && p.number === args.number);
        if (!pr) throw new Error(`no PR ${args.repo}#${args.number}`);
        pr.state = "closed";
        pr.updatedAt = Date.now();
        await this.ctx.storage.put("prs", prs);
        // The real GitHub would also send a webhook; report the topics so the caller can fan out.
        return { result: { ok: true, closedBy: grant.principal }, topics: prTopics(pr.repo) };
      }
      case "datadog.query_metrics": {
        const value = Math.round(320 + Math.random() * 160);
        return { result: [{ id: "p95", value, at: Date.now() }], topics: [] };
      }
      default:
        throw new Error(`unknown tool ${tool}`);
    }
  }

  /** What a GitHub webhook delivery represents: something changed upstream. */
  async simulateUpstream(change: { repo: string; number?: number; ci?: Pr["ci"]; title?: string; reviewers?: string[] }) {
    const prs = await this.prs();
    let pr = change.number ? prs.find((p) => p.repo === change.repo && p.number === change.number) : undefined;
    if (!pr) {
      const number = change.number ?? Math.max(0, ...prs.filter((p) => p.repo === change.repo).map((p) => p.number)) + 1;
      pr = { id: 2000 + prs.length, number, repo: change.repo, title: change.title ?? `New PR #${number}`, author: "sam", reviewers: change.reviewers ?? ["byron"], ci: "pending", state: "open", updatedAt: Date.now() };
      prs.push(pr);
    }
    if (change.ci) pr.ci = change.ci;
    if (change.title) pr.title = change.title;
    pr.updatedAt = Date.now();
    await this.ctx.storage.put("prs", prs);
    return { event: "pull_request", pr, topics: prTopics(change.repo) };
  }
}
