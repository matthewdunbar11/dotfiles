/**
 * IPC Protocol for pi-worktree daemon
 * Uses newline-delimited JSON over Unix socket
 */

import type { RepoInfo, SessionStatus, SessionStatusData } from "../types.ts";
import { userInfo } from "node:os";

// Request types
export type DaemonRequest =
  | { type: "ping" }
  | { type: "getRepos" }
  | { type: "getStatus"; worktreePath: string }
  | { type: "getAllStatuses" }
  | { type: "refreshRepos" }
  | { type: "refreshStatuses" }
  | { type: "subscribe"; event: "statusChange" | "waitingChange" }
  | { type: "unsubscribe"; event: "statusChange" | "waitingChange" };

// Response types
export type DaemonResponse =
  | { type: "pong"; timestamp: number }
  | { type: "repos"; repos: RepoInfo[] }
  | { type: "status"; worktreePath: string; status: SessionStatusData | null }
  | { type: "allStatuses"; statuses: Array<{ worktreePath: string; data: SessionStatusData }> }
  | { type: "ok" }
  | { type: "error"; message: string }
  | { type: "event"; event: "statusChange" | "waitingChange"; data: unknown };

// Daemon state (internal)
export interface DaemonState {
  repos: RepoInfo[];
  reposLastUpdated: number;
  statuses: Map<string, SessionStatusData>;
  waitingCount: number;
  waitingRepos: string[];
  subscribers: Map<string, Set<DaemonClient>>;
}

// Client interface for type safety
export interface DaemonClient {
  send(response: DaemonResponse): void;
  onDisconnect?: () => void;
}

// Get UID safely across platforms
function getUid(): number {
  // Try process.getuid() first (Unix/Linux/macOS)
  if (typeof process.getuid === "function") {
    return process.getuid();
  }
  
  // Fallback to userInfo()
  try {
    return userInfo().uid;
  } catch {
    // Last resort: use HOME directory hash
    const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
    let hash = 0;
    for (let i = 0; i < home.length; i++) {
      hash = ((hash << 5) - hash) + home.charCodeAt(i);
      hash = hash & hash;
    }
    return Math.abs(hash);
  }
}

// Socket path - user-specific to avoid conflicts
export function getSocketPath(): string {
  return `/tmp/pi-worktree-daemon-${getUid()}.sock`;
}

// Lock file to prevent duplicate daemon starts
export function getLockFilePath(): string {
  return `/tmp/pi-worktree-daemon-${getUid()}.lock`;
}
