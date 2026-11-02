// @mason/sdk as seen by a block's server half, inside its Worker Loader isolate.
//
// The isolate is stateless: the Block DO sends a snapshot (props, state, current
// query values) and `evaluate` runs setup against it, returning what the block
// wants as data (queries with resolved args, actions, describe). The DO does all
// I/O. Re-evaluating on every change keeps eviction harmless.

export const Block = { define: (def) => def };

// View-only exports, present so a module that imports them links here. Views
// never run server-side. Keep in step with frame/sdk.tsx's exports.
const viewOnly = () => {
  throw new Error("view APIs are not available in setup");
};
export const Section = viewOnly, Stat = viewOnly, Badge = viewOnly, Table = viewOnly;
export const useState = viewOnly, useMemo = viewOnly, useEffect = viewOnly, useRef = viewOnly, useCallback = viewOnly;

const DURATION = /^(\d+)(ms|s|m)$/;
function ms(d) {
  if (d == null) return null;
  const m = DURATION.exec(String(d));
  if (!m) throw new Error(`bad duration ${d}`);
  return Number(m[1]) * (m[2] === "ms" ? 1 : m[2] === "s" ? 1000 : 60000);
}

const toolRefs = new Proxy({}, {
  get: (_, server) => new Proxy({}, { get: (_, tool) => ({ tool: `${String(server)}.${String(tool)}` }) }),
});

export function evaluate(def, snap) {
  const props = snap.props ?? {};
  const stateVals = snap.state ?? {};
  const values = snap.values ?? {};
  const queries = [];
  const actions = [];
  const stateDefaults = {};
  const errors = [];
  let describeFn = null;

  const block = {
    props,
    state(key, initial) {
      stateDefaults[key] = initial;
      return { name: key, get value() { return key in stateVals ? stateVals[key] : initial } };
    },
    query(name, ref, argsFn, opts = {}) {
      let args = null;
      // A null result means "not yet" (a dependent query waiting on another).
      try { args = argsFn() ?? null } catch (e) { errors.push(`query ${name}: ${e.message}`) }
      queries.push({ name, tool: ref.tool, args, key: opts.key ?? "id", refreshMs: ms(opts.refresh) });
      const v = values[name];
      return { name, get value() { return v?.rows }, get status() { return v?.status ?? "pending" } };
    },
    action(name, ref, opts = {}) {
      actions.push({
        name,
        tool: ref.tool,
        invalidates: (opts.invalidates ?? []).map((h) => (typeof h === "string" ? h : h.name)),
        permission: opts.permission ?? "write",
      });
    },
    describe(fn) { describeFn = fn },
  };

  try { def.setup(block, { mcp: toolRefs }) } catch (e) { errors.push(`setup: ${e.message}`) }
  let describe = null;
  try { describe = describeFn ? String(describeFn()) : null } catch (e) { errors.push(`describe: ${e.message}`) }
  return { id: def.id, tools: def.tools ?? [], queries, actions, describe, stateDefaults, errors };
}
