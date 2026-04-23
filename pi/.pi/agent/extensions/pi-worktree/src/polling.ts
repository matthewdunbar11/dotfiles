import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { SessionStatus, SessionStatusData, PollingOptions } from "./types.ts";
import { StatusService } from "./status.ts";
import { discoverRepos } from "./git.ts";

// Global polling state
let pollInterval: ReturnType<typeof setInterval> | null = null;
let lastStatuses = new Map<string, SessionStatus | null>();
let lastWaitingCount = 0;
let lastWaitingRepos: string[] = [];

// Start polling for status changes
export function startPolling(
  pi: ExtensionAPI,
  options: PollingOptions = { intervalMs: 5000 },
): void {
  // Clear any existing polling
  stopPolling();

  const statusService = new StatusService(pi);

  pollInterval = setInterval(async () => {
    try {
      const repos = await discoverRepos(pi);
      const currentStatuses = new Map<string, SessionStatus | null>();
      let waitingCount = 0;
      const waitingRepos: string[] = [];

      for (const repo of repos) {
        let repoHasWaiting = false;

        for (const worktree of repo.worktrees) {
          const statusData = await statusService.read(worktree.path);
          const status = statusData?.status ?? null;
          const prevStatus = lastStatuses.get(worktree.path);

          // Track for waiting count
          if (status === "waiting") {
            waitingCount++;
            repoHasWaiting = true;
          }

          // Detect changes
          if (status !== prevStatus) {
            currentStatuses.set(worktree.path, status);
            options.onStatusChange?.(worktree.path, prevStatus, status);
          } else {
            currentStatuses.set(worktree.path, status);
          }
        }

        if (repoHasWaiting) {
          waitingRepos.push(repo.name);
        }
      }

      // Update global status tracking
      lastStatuses = currentStatuses;

      // Notify if waiting count changed
      if (waitingCount !== lastWaitingCount || 
          JSON.stringify(waitingRepos) !== JSON.stringify(lastWaitingRepos)) {
        lastWaitingCount = waitingCount;
        lastWaitingRepos = waitingRepos;
        options.onWaitingChange?.(waitingCount, waitingRepos);
      }
    } catch (err) {
      // Silently ignore polling errors to avoid spam
      console.error("Polling error:", err);
    }
  }, options.intervalMs);
}

// Stop polling
export function stopPolling(): void {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

// Check if polling is active
export function isPolling(): boolean {
  return pollInterval !== null;
}

// Get the last known waiting count
export function getLastWaitingCount(): number {
  return lastWaitingCount;
}

// Get the last known waiting repos
export function getLastWaitingRepos(): string[] {
  return [...lastWaitingRepos];
}

// Force a refresh now
export async function refreshNow(
  pi: ExtensionAPI,
  onStatusChange?: (worktreePath: string, oldStatus: SessionStatus | null, newStatus: SessionStatus | null) => void,
): Promise<void> {
  const statusService = new StatusService(pi);
  const repos = await discoverRepos(pi);

  for (const repo of repos) {
    for (const worktree of repo.worktrees) {
      const statusData = await statusService.read(worktree.path);
      const status = statusData?.status ?? null;
      const prevStatus = lastStatuses.get(worktree.path);

      if (status !== prevStatus) {
        lastStatuses.set(worktree.path, status);
        onStatusChange?.(worktree.path, prevStatus, status);
      }
    }
  }
}
