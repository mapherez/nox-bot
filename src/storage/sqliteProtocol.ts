import type { StateChange, StateRow } from "../core/state.js";
export interface SqliteSnapshot {
  rows: StateRow[];
  sequence: bigint;
}
export type SqliteRequest = { id: number } & (
  | { type: "open"; filename: string; create: boolean }
  | { type: "mutate"; changes: readonly StateChange[] }
  | { type: "close" }
);
export type SqliteReply =
  | { id: number; snapshot?: SqliteSnapshot }
  | {
      id: number;
      error: {
        code: "STATE_CONFLICT" | "STATE_UNAVAILABLE" | "INVALID_STATE";
        message: string;
      };
    };
