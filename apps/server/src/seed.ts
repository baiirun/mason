import { applyOp, block, col, emptyWorkspace, row, spaceFromTemplate, tabs, type Workspace } from "@mason/core";

/** First-run workspace. Layouts as code, compiled to ops. */
export function seedWorkspace(): Workspace {
  const review = spaceFromTemplate(
    "Review",
    row(
      [0.3, 0.4, 0.3],
      tabs(block("inspect.doc", { docId: "spec" }), block("inspect.session.children", { sessionId: "s-auth" }, { link: "A" })),
      col([0.6, 0.4], block("inspect.session", { sessionId: "s-auth" }, { link: "A" }), block("inspect.session.diffs", {}, { link: "A" })),
      block("inspect.preview", {}, { link: "A" }),
    ),
    "space-review",
  );
  // An agent next to a doc and the work it should write about. Unlinked, so it sees the whole space.
  const write = spaceFromTemplate(
    "Write",
    row(
      [0.4, 0.6],
      block("inspect.doc", { docId: "notes" }),
      col([0.6, 0.4], block("inspect.session", { sessionId: "s-docs" }), row(block("inspect.session.diffs", { sessionId: "s-auth" }), block("inspect.session.children", { sessionId: "s-auth" }))),
    ),
    "space-write",
  );
  return [review, write].reduce(applyOp, emptyWorkspace());
}
