// Types and interfaces for pi-worktree extension

export type SessionStatus = "idle" | "busy" | "waiting";

export interface SessionStatusData {
  lastUpdated: number;
  status: SessionStatus;
  worktreePath: string;
}

export interface RepoInfo {
  path: string;
  name: string;
  worktrees: WorktreeInfo[];
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  isMain: boolean;
  isBare: boolean;
}

export interface SelectItem {
  value: string;
  label: string;
  description?: string;
}

export interface RepoStatus {
  status: SessionStatus | null;
  indicator: string;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
  error?: Error;
}

// Polling callback types
export type StatusChangeCallback = (worktreePath: string, oldStatus: SessionStatus | null, newStatus: SessionStatus | null) => void;
export type WaitingCountCallback = (count: number, repos: string[]) => void;

export interface PollingOptions {
  intervalMs: number;
  onStatusChange?: StatusChangeCallback;
  onWaitingChange?: WaitingCountCallback;
}
