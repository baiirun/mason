# Workflow API (draft)

Workflows combine the three things Mason multiplexes: **blocks** for seeing and steering, **MCP tools** for acting, and **sessions** for judgment. Every interaction with any of them is a durable step. Nothing here is implemented; the Effect API questions in [overview.md](overview.md#open-questions) are still open, so the examples use the Effect-style shape but may change.

Mason does not build an execution engine. A workflow compiles onto Cloudflare Workflows for durability and onto the existing session runtime for agent steps.

## Relationship to automations

The product's automations are a trigger plus a prompt that runs an agent session. That is a workflow with a single `step.agent`. Prompt automations and code workflows share one run model, one run list and one trigger router. Prompt automations stay the fast way to start and the right tool for open-ended work; a stable one can be promoted to a code workflow, written by an agent, with `step.agent` where it still needs judgment.

## Authoring

`workflows/<id>.ts` in the same workspace repo as `blocks/*.tsx`, published by push with the same checks (see [block-code-api.md](block-code-api.md#publishing)). The commit is the version. A feature is usually a workflow plus the blocks it uses:

```
workflows/red-ci.ts          trigger, steps
blocks/triage-result.tsx     what a run shows and asks
blocks/ci-board.tsx          emits the trigger
```

```ts
export default Workflow.define({
  id: "red-ci",
  trigger: { event: "ci-board.pr_turned_red" },
  run: (event, step) => Effect.gen(function* () {
    const pr = event.payload.prs[0];
    const logs = yield* step.tool("logs", ctx.mcp.github.get_job_logs, { repo: pr.repo, number: pr.number });

    const triage = yield* step.agent("triage", {
      prompt: "Decide if this CI failure is flaky or real, and propose a fix if real.",
      input: { pr, logs },
      blocks: ["ci-board"],
      output: Schema.Struct({ verdict: Schema.Literal("flaky", "real"), summary: Schema.String }),
    });
    if (triage.verdict === "flaky") return yield* step.tool("rerun", ctx.mcp.github.rerun_job, { repo: pr.repo, number: pr.number });

    const card = yield* step.open("triage-result", { props: { pr, ...triage }, near: "ci-board" });
    const decision = yield* step.waitFor(card, "decision", { timeout: "4 hours" });
    if (decision?.payload.approved) {
      yield* step.tool("issue", ctx.mcp.github.create_issue, { repo: pr.repo, title: `CI: ${pr.title}`, body: triage.summary });
      yield* step.prompt({ session: "oncall" }, `Opened an issue for ${pr.repo}#${pr.number}: ${triage.summary}`);
    }
  }),
});
```

## Triggers

The same router as automations: block events (`<module>.<event>`, optionally narrowed to one block), event actions, Datadog monitors, cron, GitHub events. A workflow doesn't care what started it; the trigger arrives as an envelope (see [block-code-api.md](block-code-api.md#envelope)).

## Steps

| Resource | Step | Meaning |
|---|---|---|
| Tools | `step.tool(name, tool, args)` | One retried call through the MCP gateway, under the run's principal. |
| Blocks | `step.read(block)` | The block's agent view: describe line, status, outline, rows. |
| | `step.setState(block, key, value)`, `step.act(block, action, input)` | Change a block or run its action. |
| | `step.open(module, { props, near })` | Open a block on the canvas, recorded as opened by the run. |
| | `step.waitFor(block, event, { timeout })` | Pause until the block emits the event or someone clicks an event action on it. |
| Sessions | `step.agent(name, { prompt, input, output, blocks?, tools? })` | Start a session, wait for it, return its output checked against the schema. Viewable as a session block while it runs. |
| | `step.prompt(session, message)` | Send a message into an existing session. |
| | `step.waitForSession(session)` | Wait for a session to finish. |
| Control | `step.sleep(duration)`, `step.waitForEvent(name, opts)`, plain code | Cloudflare Workflows' own primitives. |

Every step is durable, retried by its policy, and recorded in the run's history, which doubles as its audit trail.

## How workflows and blocks connect

1. **Blocks start runs:** block events and event actions are triggers.
2. **Runs read and drive blocks:** `step.read`, `step.setState`, `step.act`, each carrying the run's cause.
3. **Runs put results on the canvas:** `step.open` places a block next to whatever triggered the run. A run can mark the blocks it opened as temporary (closed when it ends) or leave them. Closing a block never cancels the run.
4. **Runs wait on blocks:** `step.waitFor` pauses on Workflows' `waitForEvent`. The block shows Approve and Reject; a click is an event action that the router delivers to the waiting instance. This is how unattended writes get a person's approval.
5. **Blocks show runs:** a built-in run block (steps, current wait, approvals, links to sessions), and `ctx.mason.runs` as a query source so any block can show runs live.

## Identity, cause and status

- A run has one identity, `workflow:<id>/run:<id>`, carried on tool calls, block writes and session prompts. Blocks and sessions show "started by" it, and the loop guard uses it as the cause.
- A run reports Rex-style status: `working` while a step runs, `blocked` with kind `permission` while waiting on an approval, `finished` or `failed` at the end.

## Versioning

A run executes the workflow code it started with: each step runs in the module's isolate, loaded by the version hash recorded at the start. Blocks the run opens follow their module's head as usual.

## Execution

The platform deploys one generic workflow runner (a Cloudflare `WorkflowEntrypoint`), because agent-written code is loaded at runtime and can't declare its own Workflows class. Each `step.*` maps onto `step.do`, `step.sleep` or `step.waitForEvent`; inside, the step's code runs in the module's Worker Loader isolate, tool calls go through the gateway, and `step.agent` starts a session on the session runtime and waits for it.

## Open questions

- The Effect API shape (see the overview).
- Whether Workflows instances can be created and sent events from Durable Objects, and their concurrency limits.
- How long-running agent steps map onto Workflows step limits (one step per session, or one per model turn).
