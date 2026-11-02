# Mason: a multiplexer frontend and backend API

Mason lays out and drives many live things in one place, for people and agents alike. The frontend is a canvas of blocks; the backend is an API that multiplexes the data, sessions and processes behind them. This page is the map: what each layer is, what Mason owns, and what it hands to existing primitives.

`apps/edge` is a local prototype of this design on Cloudflare Workers (workerd/miniflare), with Postgres, the MCP gateway and Cloudflare Artifacts mocked. The real product runs on Cloudflare Workers with a separate Postgres backend and an existing sessions and automations runtime.

Specs:

- [block-code-api.md](block-code-api.md): writing, checking and publishing block code; block events and status.
- [canvas-api.md](canvas-api.md): which blocks exist and where; the HTTP, WebSocket and embedding protocols.
- [workflow-api.md](workflow-api.md): draft. Workflows that combine blocks, tools and sessions.

## Layers

| | Frontend (canvas) | Backend API |
|---|---|---|
| **Blocks** | Sandboxed views, layout, focus, link groups | Block Durable Objects: query data, state, change streams, events, status |
| **Sessions** | Session blocks: transcript, input, approvals | The existing session runtime |
| **Processes** (automations, workflows) | Run blocks and chips: status, approve or reject, pause | Triggers and runs on Cloudflare Workflows plus sessions |
| **Connectors** | What a block or run touches | The MCP gateway: user- and org-scoped credentials |

- **Code and canvas are separate.** Block and workflow code lives in a git repo per workspace and is published by push. Which blocks exist, their props and their layout belong to a server-owned Canvas DO, changed only by ops that the UI and agents share. Commits never move blocks; canvas ops never touch git.
- **The workspace owns processes; blocks surface them.** A block can start, show or steer an automation or workflow run, but closing a block never stops one. Anything running on someone's behalf should be visible on the canvas.
- **Agents are actors, not a separate system.** An agent edits code through git, arranges the canvas through ops, reads blocks through their agent view, and its own run is a process a block can show.

## One SDK

```
@mason/sdk
  /block      Block.define, query, state, action, on, emit, status, describe   (block isolate + view)
  /ui         Section, Table, Stat, Badge...                                   (view)
  /workflow   Workflow.define and its steps (draft)                            (workflow runner)
  /client     canvas ops, block read and act, sessions, events                 (agents, scripts, services)
  /effect     the same APIs, Effect-native (open question)                     (opt-in)
```

## What Mason owns and what it delegates

Mason owns the parts that make it a multiplexer:

- the block model and its sandboxes (Worker Loader isolates on the server, `allow-scripts` iframes on a separate origin in the browser);
- the canvas model and its ops;
- the event and status model: block events, event actions, causes and the loop guard, Rex-style status;
- one identity and cause flowing through blocks, sessions and runs;
- the step vocabulary that ties blocks, tools and sessions together;
- git-based authoring and publishing.

It delegates execution guarantees:

| Need | Primitive |
|---|---|
| Durable steps, retries, sleeps, waiting for events | Cloudflare Workflows |
| Live per-entity state and sockets | Durable Objects |
| Agent loops, model routing, session persistence | The existing session runtime |
| Event delivery | Cloudflare Queues |
| Tool access and credentials | The MCP gateway |
| Durable records and indexes | Postgres |
| Code storage and history | Git (Cloudflare Artifacts) |

The rule: if a feature needs a scheduler, checkpointing, a retry policy engine or a model router, it belongs to a primitive. The SDK gives it Mason's names and wiring, nothing more.

## Events and status, after Rex

Mason's event model follows Rex's, which separates two things:

- **Events** say something happened. Blocks emit named events (`<module>.<event>`, like Rex's `<kind>.<event>`); the canvas socket can stream every event in a workspace; automations subscribe to them.
- **Status** says what something is doing now: `idle`, `working`, `blocked` (with a kind such as `permission`), `finished`, `failed`, and a message, following Rex's Program Status Protocol (OSC 7501). Blocks, sessions and runs all report it, so the canvas can show one consistent picture and one list of what's waiting on a person.

A terminal block backed by Rex could forward Rex's events and program status as block events and status, so agents running in terminals appear on the canvas without extra integration.

## Open questions

- The Effect API: long-lived `setup` per block version (with a `Scope`) or stateless re-evaluation; Effect-only or plain and Effect side by side; services or a `ctx` object.
- Agent visibility of rendered UI: rows on request, a view outline from `@mason/ui`, screenshots.
- Per-block tool consent (removed for now; blocks use their principal's credentials, and writes should be `confirm` actions or approval steps).
