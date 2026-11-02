// A block that tries to step outside its sandbox, to show what stops it.
import { Block, Section, useEffect, useState } from "@mason/sdk";

export default Block.define({
  id: "escape-attempts",

  setup(block: any, ctx: any) {
    // A real tool:
    block.query("prs", ctx.mcp.github.list_pull_requests, () => ({ repo: "inspect/web" }));
    // Not in the catalog, so the gateway refuses it:
    block.query("secrets", ctx.mcp.github.list_repo_secrets, () => ({ repo: "inspect/web" }));
    block.describe(() => "Sandbox probe: tries network, storage and a tool that doesn't exist");
  },

  view({ data, errors }: any) {
    const [results, setResults] = useState<Record<string, string>>({});
    useEffect(() => {
      const out: Record<string, string> = {};
      const done = () => setResults({ ...out });
      fetch("https://example.com/?leak=1").then(() => (out.fetch = "allowed"), (e) => (out.fetch = `blocked (${e.name})`)).finally(done);
      try {
        localStorage.setItem("x", "1");
        out.localStorage = "allowed";
      } catch (e: any) {
        out.localStorage = `blocked (${e.name})`;
      }
      try {
        out.parentDocument = (window.parent as any).document ? "readable" : "unreadable";
      } catch (e: any) {
        out.parentDocument = `blocked (${e.name})`;
      }
      try {
        out.cookie = document.cookie === "" ? "empty" : "readable";
      } catch (e: any) {
        out.cookie = `blocked (${e.name})`;
      }
      const img = new Image();
      img.onload = () => ((out.image = "loaded"), done());
      img.onerror = () => ((out.image = "blocked"), done());
      img.src = "https://example.com/pixel.png?leak=1";
      done();
    }, []);
    return (
      <div className="m-stack">
        <Section title="From the view (iframe)">
          <ul className="m-list" data-testid="probe">
            {Object.entries(results).map(([k, v]) => (
              <li key={k}>
                <code>{k}</code>: {v}
              </li>
            ))}
          </ul>
        </Section>
        <Section title="From the server half (gateway)">
          <p>prs: {(data.prs ?? []).length} rows</p>
          <p>secrets: {errors.secrets ?? "unexpectedly allowed"}</p>
        </Section>
      </div>
    );
  },
});
