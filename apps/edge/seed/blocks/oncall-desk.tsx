// An agent-style block: PRs waiting on a reviewer, plus a p95 latency that can only be polled.
import { Badge, Block, Section, Stat, Table, useState } from "@mason/sdk";

type Pr = { id: number; number: number; repo: string; title: string; author: string; reviewers: string[]; ci: string };

export default Block.define({
  id: "oncall-desk",

  setup(block: any, ctx: any) {
    const reviewer = block.state("reviewer", "byron");
    const prs = block.query("prs", ctx.mcp.github.list_pull_requests, () => ({ repo: block.props.repo, state: "open" }));
    const p95 = block.query("p95", ctx.mcp.datadog.query_metrics, () => ({ query: `p95:latency{repo:${block.props.repo}}` }), { refresh: "5s" });
    block.action("close", ctx.mcp.github.close_pull_request, { invalidates: [prs], permission: "confirm" });
    block.describe(() => {
      const all: Pr[] = prs.value ?? [];
      const mine = all.filter((p) => p.reviewers.includes(reviewer.value));
      const red = mine.filter((p) => p.ci === "failing").length;
      return `${block.props.repo}: ${mine.length} of ${all.length} open PRs need ${reviewer.value}${red ? ` (${red} failing CI)` : ""} · p95 ${p95.value?.[0]?.value ?? "?"}ms`;
    });
  },

  view({ data, status, state, setState, act }: any) {
    const [busy, setBusy] = useState<number | null>(null);
    const prs: Pr[] = data.prs ?? [];
    const mine = prs.filter((p) => p.reviewers.includes(state.reviewer)).sort((a, b) => b.number - a.number);
    const p95 = data.p95?.[0]?.value;
    const close = async (pr: Pr) => {
      if (busy) return;
      setBusy(pr.number);
      try {
        await act("close", { repo: pr.repo, number: pr.number }, { confirmed: true });
      } finally {
        setBusy(null);
      }
    };
    return (
      <div className="m-stack">
        <div className="m-row">
          <Stat label="Need review" value={status.prs === "ready" ? mine.length : "…"} />
          <Stat label="p95 latency" value={p95 ? `${p95}ms` : "…"} tone={p95 > 400 ? "bad" : p95 > 360 ? "warn" : "good"} />
          <label className="m-field">
            Reviewer
            <select value={state.reviewer} onChange={(e: any) => setState("reviewer", e.target.value)}>
              <option>byron</option>
              <option>maya</option>
              <option>sam</option>
            </select>
          </label>
        </div>
        <Section title={`Waiting on ${state.reviewer}`}>
          <Table
            rows={mine}
            empty="Nothing waiting on this reviewer."
            columns={[
              { label: "#", render: (p: Pr) => p.number },
              { label: "Title", render: (p: Pr) => p.title },
              { label: "Author", render: (p: Pr) => p.author },
              { label: "CI", render: (p: Pr) => <Badge tone={p.ci === "passing" ? "good" : p.ci === "failing" ? "bad" : "warn"}>{p.ci}</Badge> },
              { label: "", render: (p: Pr) => <button disabled={busy === p.number} onClick={() => close(p)}>{busy === p.number ? "Closing…" : "Close"}</button> },
            ]}
          />
        </Section>
      </div>
    );
  },
});
