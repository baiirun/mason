// Types for @mason/sdk, the only module block code may import.

declare module "@mason/sdk" {
  type Duration = `${number}${"ms" | "s" | "m"}`;
  type Status = "pending" | "waiting" | "ready" | "error";

  export interface Tool<Args = any, Row = any> {
    readonly tool: string;
    /** @internal type-only */ readonly __types?: [Args, Row];
  }

  export interface PullRequest {
    id: number;
    number: number;
    repo: string;
    title: string;
    author: string;
    reviewers: string[];
    ci: "passing" | "failing" | "pending";
    state: "open" | "closed";
    updatedAt: number;
  }

  export interface Tools {
    github: {
      list_pull_requests: Tool<{ repo: string; state?: "open" | "closed" }, PullRequest>;
      close_pull_request: Tool<{ repo: string; number: number }, { ok: boolean; closedBy: string }>;
    };
    datadog: {
      query_metrics: Tool<{ query: string }, { id: string; value: number; at: number }>;
    };
  }

  export interface Query<Row> {
    readonly name: string;
    /** The current rows, or undefined before the first fetch. */
    readonly value: Row[] | undefined;
    readonly status: Status;
  }

  export interface StateRef<T> {
    readonly name: string;
    readonly value: T;
  }

  export interface SetupBlock<Props> {
    readonly props: Props;
    state<T>(key: string, initial: T): StateRef<T>;
    query<Args, Row>(
      name: string,
      tool: Tool<Args, Row>,
      args: () => Args | null | undefined,
      opts?: { refresh?: Duration; key?: string },
    ): Query<Row>;
    action<Args>(
      name: string,
      tool: Tool<Args, any>,
      opts?: { invalidates?: Array<Query<any> | string>; permission?: "read" | "write" | "confirm" },
    ): void;
    describe(fn: () => string): void;
  }

  export interface SetupContext {
    mcp: Tools;
  }

  export interface ViewProps {
    data: Record<string, any[]>;
    status: Record<string, Status>;
    errors: Record<string, string>;
    state: Record<string, any>;
    setState(key: string, value: unknown): void;
    act(name: string, input: unknown, opts?: { confirmed?: boolean }): Promise<unknown>;
    refresh(): void;
  }

  export interface BlockDefinition<Props> {
    id: string;
    tools: string[];
    setup(block: SetupBlock<Props>, ctx: SetupContext): void;
    view?(props: ViewProps): any;
  }

  export const Block: {
    define<Props = Record<string, any>>(def: BlockDefinition<Props>): BlockDefinition<Props>;
  };

  type Tone = "good" | "warn" | "bad";
  export function Section(props: { title: string; children?: any }): any;
  export function Stat(props: { label: string; value: any; tone?: Tone }): any;
  export function Badge(props: { tone?: Tone; children?: any }): any;
  export function Table<T>(props: { rows: T[]; columns: { label: string; render: (row: T) => any }[]; empty?: string }): any;

  export function useState<T>(initial: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void];
  export function useMemo<T>(fn: () => T, deps: readonly unknown[]): T;
  export function useEffect(fn: () => void | (() => void), deps?: readonly unknown[]): void;
  export function useRef<T>(initial: T): { current: T };
  export function useCallback<T extends (...args: any[]) => any>(fn: T, deps: readonly unknown[]): T;
}

declare module "@mason/sdk/jsx-runtime" {
  export const jsx: any;
  export const jsxs: any;
  export const Fragment: any;
  export namespace JSX {
    type Element = any;
    // React's `key` works on any element, including SDK components.
    interface IntrinsicAttributes {
      key?: string | number | null;
    }
    interface IntrinsicElements {
      [tag: string]: any;
    }
  }
}
