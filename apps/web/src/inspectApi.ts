// Client for the stand-in inspect backend in apps/server. Blocks only hold ids; the data
// comes from here (in inspect: the real API and query cache).
import { useSyncExternalStore } from "react";
import type { Db, DataMsg } from "../../server/src/inspect/types";

export type { Session, Doc, Diff, Message } from "../../server/src/inspect/types";

let db: Db = { sessions: {}, docs: {} };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

// Docs being edited locally win over server pushes until the server has our latest text.
const localDocs = new Map<string, string>();

function connect() {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/data`);
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data) as DataMsg;
    const docs = { ...msg.db.docs };
    for (const [id, body] of localDocs) {
      if (docs[id]?.body === body) localDocs.delete(id);
      else if (docs[id]) docs[id] = { ...docs[id]!, body };
    }
    db = { ...msg.db, docs };
    emit();
  };
  ws.onclose = () => setTimeout(connect, 1000);
}
connect();

const useDb = <T,>(sel: (d: Db) => T) => useSyncExternalStore(subscribe, () => sel(db));

export const useSession = (id?: string) => useDb((d) => (id ? d.sessions[id] : undefined));
export const useAllSessions = () => useDb((d) => d.sessions);
export const useDoc = (id?: string) => useDb((d) => (id ? d.docs[id] : undefined));
export const allSessions = () => Object.values(db.sessions);
export const allDocs = () => Object.values(db.docs);

let docTimer: number | undefined;
export function saveDoc(id: string, body: string) {
  // Optimistic: show the edit now, send it shortly after typing pauses.
  localDocs.set(id, body);
  db = { ...db, docs: { ...db.docs, [id]: { ...db.docs[id]!, body } } };
  emit();
  clearTimeout(docTimer);
  docTimer = window.setTimeout(() => {
    void fetch(`/api/docs/${id}`, { method: "POST", body: JSON.stringify({ body }) });
  }, 150);
}

/** Send a message to a session's agent. `blockId` tells the agent which block it's in. */
export function sendMessage(sessionId: string, text: string, blockId?: string) {
  void fetch(`/api/sessions/${sessionId}/messages`, { method: "POST", body: JSON.stringify({ text, blockId }) });
}
