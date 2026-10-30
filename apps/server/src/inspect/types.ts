// Shapes of the stand-in inspect backend. The web app imports these as types only.
export interface Message {
  role: "user" | "agent" | "tool" | "context";
  text: string;
}
export interface Diff {
  path: string;
  added: number;
  removed: number;
  patch: string;
}
export interface Session {
  id: string;
  name: string;
  parentId: string | null;
  status: "idle" | "running";
  messages: Message[];
  diffs: Diff[];
  previewUrl: string;
}
export interface Doc {
  id: string;
  title: string;
  body: string;
}
export interface Db {
  sessions: Record<string, Session>;
  docs: Record<string, Doc>;
}

/** Messages on the /data socket. */
export type DataMsg = { type: "db"; db: Db };
