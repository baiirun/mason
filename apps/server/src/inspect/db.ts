// Stand-in for inspect's backend: sessions, docs and diffs, in memory, persisted to a JSON file.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db, Doc, Message, Session } from "./types";

const FILE = join(dirname(fileURLToPath(import.meta.url)), "../../data/inspect.json");

const patch = (path: string, lines: string[]) =>
  `--- a/${path}\n+++ b/${path}\n@@ -1,4 +1,${lines.length + 2} @@\n${lines.join("\n")}`;

export function seedDb(): Db {
  const s = (id: string, name: string, parentId: string | null, extra: Partial<Session> = {}): Session => ({
    id,
    name,
    parentId,
    status: "idle",
    messages: [],
    diffs: [],
    previewUrl: `http://localhost:3000/${id}`,
    ...extra,
  });
  return {
    sessions: {
      "s-auth": s("s-auth", "Refactor auth flow", null, {
        messages: [
          { role: "user", text: "Move session handling out of the login page and into a hook." },
          { role: "agent", text: "I'll extract useAuthSession() and split the token refresh into its own child session." },
        ],
        diffs: [
          {
            path: "src/auth/useAuthSession.ts",
            added: 42,
            removed: 0,
            patch: patch("src/auth/useAuthSession.ts", ["+export function useAuthSession() {", "+  const [session, setSession] = useState<Session | null>(null);", "+  // ...", "+}"]),
          },
          {
            path: "src/pages/login.tsx",
            added: 6,
            removed: 31,
            patch: patch("src/pages/login.tsx", ["-  const [session, setSession] = useState(null);", "-  useEffect(() => { refreshToken() }, []);", "+  const session = useAuthSession();", " return <LoginForm session={session} />"]),
          },
        ],
      }),
      "s-refresh": s("s-refresh", "Token refresh worker", "s-auth", {
        messages: [{ role: "agent", text: "Writing a background refresh with exponential backoff." }],
        diffs: [{ path: "src/auth/refresh.ts", added: 58, removed: 0, patch: patch("src/auth/refresh.ts", ["+export async function refreshLoop(signal: AbortSignal) {", "+  let delay = 1000;", "+}"]) }],
      }),
      "s-tests": s("s-tests", "Auth tests", "s-auth", {
        messages: [{ role: "agent", text: "Adding tests for expired and revoked tokens." }],
        diffs: [{ path: "test/auth.test.ts", added: 77, removed: 0, patch: patch("test/auth.test.ts", ["+it('refreshes an expired token', async () => {", "+})"]) }],
      }),
      "s-docs": s("s-docs", "Docs pass", null, {
        messages: [{ role: "agent", text: "Ready to help. Try “write the release notes” or “what can you see?”." }],
      }),
    },
    docs: {
      spec: {
        id: "spec",
        title: "Auth refactor spec",
        body: "# Auth refactor\n\nGoals\n- Session state lives in one hook\n- Refresh runs in the background\n- Login page is presentational\n\nOpen questions\n- Do we keep the cookie fallback?",
      },
      notes: { id: "notes", title: "Release notes", body: "## Next release\n\n" },
    },
  };
}

export let db: Db = existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : seedDb();

const listeners = new Set<() => void>();
export const onDbChange = (fn: () => void) => listeners.add(fn);

let saveTimer: NodeJS.Timeout | undefined;
function update(fn: (d: Db) => Db) {
  db = fn(db);
  listeners.forEach((l) => l());
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify(db, null, 2));
  }, 250);
}

export function resetDb() {
  update(() => seedDb());
}

export function setDoc(id: string, fn: (d: Doc) => Doc) {
  const doc = db.docs[id];
  if (!doc) throw new Error(`doc ${id} not found`);
  update((d) => ({ ...d, docs: { ...d.docs, [id]: fn(doc) } }));
}

export function setSession(id: string, fn: (s: Session) => Session) {
  const s = db.sessions[id];
  if (!s) throw new Error(`session ${id} not found`);
  update((d) => ({ ...d, sessions: { ...d.sessions, [id]: fn(s) } }));
}

export function addSession(s: Session) {
  update((d) => ({ ...d, sessions: { ...d.sessions, [s.id]: s } }));
}

export function pushMessage(sessionId: string, m: Message) {
  setSession(sessionId, (s) => ({ ...s, messages: [...s.messages, m] }));
}

/** Replace the text of the last message (for streaming). */
export function setLastMessage(sessionId: string, text: string) {
  setSession(sessionId, (s) => {
    const messages = [...s.messages];
    messages[messages.length - 1] = { ...messages[messages.length - 1]!, text };
    return { ...s, messages };
  });
}
