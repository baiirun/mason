// Main module of every block isolate. The compiled block is "block.js"; the SDK
// and a no-op JSX runtime sit beside it (views never run server-side).
import { WorkerEntrypoint } from "cloudflare:workers";
import { evaluate } from "./mason-sdk.js";
import def from "./block.js";

export default class BlockIsolate extends WorkerEntrypoint {
  evaluate(snapshot) {
    return evaluate(def, snapshot);
  }

  // Lets the prototype show what the sandbox allows. Not part of the real API.
  async probe() {
    const out = { envKeys: Object.keys(this.env ?? {}) };
    try {
      await fetch("https://example.com");
      out.fetch = "allowed";
    } catch (e) {
      out.fetch = `blocked: ${e.message}`;
    }
    return out;
  }
}
