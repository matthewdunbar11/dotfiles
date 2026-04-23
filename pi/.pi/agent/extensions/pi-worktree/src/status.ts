import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { SessionStatus, SessionStatusData, RepoInfo, RepoStatus } from "./types.ts";
import {
  getCurrentSession,
  getTmuxSessions,
  getSessionOption,
  setSessionOption,
} from "./tmux.ts";
import { getSessionName } from "./utils.ts";

// Status tracking service - centralized status management
export class StatusService {
  private currentStatus: SessionStatus = "idle";
  private currentWorktreePath: string | null = null;

  constructor(private pi: ExtensionAPI) {}

  // Get current status value for the current session's worktree
  async getStatus(): Promise<SessionStatus | null> {
    const { getCurrentWorktreePath } = await import("./git.ts");
    const worktreePath = await getCurrentWorktreePath(this.pi);
    if (!worktreePath) return null;

    const statusData = await this.read(worktreePath);
    return statusData?.status ?? null;
  }

  // Get current worktree path
  getWorktreePath(): string | null {
    return this.currentWorktreePath;
  }

  // Set current worktree path (called on session start)
  setWorktreePath(path: string): void {
    this.currentWorktreePath = path;
  }

  // Read status for a specific worktree by looking up its session
  async read(worktreePath: string): Promise<SessionStatusData | null> {
    const sessionName = await this.findSessionByWorktree(worktreePath);
    if (!sessionName) return null;

    const status = await getSessionOption(this.pi, sessionName, "@pi-status");
    if (!status || !["idle", "busy", "waiting"].includes(status)) {
      return null;
    }

    const lastUpdatedStr = await getSessionOption(
      this.pi,
      sessionName,
      "@pi-lastUpdated",
    );
    const lastUpdated = lastUpdatedStr
      ? parseInt(lastUpdatedStr, 10)
      : Date.now();

    return {
      status: status as SessionStatus,
      lastUpdated,
      worktreePath,
    };
  }

  // Write status for current session
  async write(status: SessionStatus): Promise<void> {
    // Dynamically get current worktree to avoid stale state from shared instance
    const { getCurrentWorktreePath } = await import("./git.ts");
    const worktreePath = await getCurrentWorktreePath(this.pi);
    if (!worktreePath) return;

    const sessionName = await getCurrentSession(this.pi);
    if (!sessionName) return;

    await this.writeToSession(sessionName, worktreePath, status);
  }

  // Write status to a specific worktree's session (used when switching to another worktree)
  async writeToWorktree(worktreePath: string, status: SessionStatus): Promise<void> {
    const sessionName = await this.findSessionByWorktree(worktreePath);
    if (!sessionName) return;

    await this.writeToSession(sessionName, worktreePath, status);
  }

  // Internal: write status to a specific session
  private async writeToSession(
    sessionName: string,
    worktreePath: string,
    status: SessionStatus,
  ): Promise<void> {
    const now = Date.now();

    await setSessionOption(this.pi, sessionName, "@pi-status", status);
    await setSessionOption(this.pi, sessionName, "@pi-lastUpdated", now.toString());
    await setSessionOption(this.pi, sessionName, "@pi-worktree", worktreePath);

    if (worktreePath === this.currentWorktreePath) {
      this.currentStatus = status;
    }
  }

  // Find tmux session associated with a worktree
  // Public because worktree picker uses it to find sessions for deletion
  async findSessionByWorktree(worktreePath: string): Promise<string | null> {
    const sessions = await getTmuxSessions(this.pi);

    // First: check @pi-worktree option on all sessions
    for (const sessionName of sessions) {
      const wt = await getSessionOption(this.pi, sessionName, "@pi-worktree");
      if (wt === worktreePath) {
        return sessionName;
      }
    }

    // Fallback: try derived session name (backward compatibility)
    const derivedName = getSessionName(worktreePath);
    if (sessions.includes(derivedName)) {
      return derivedName;
    }

    return null;
  }

  // Get rolled-up status for a repo (most urgent: waiting > busy > idle)
  async getRepoStatus(repo: RepoInfo): Promise<RepoStatus> {
    const statuses = await Promise.all(
      repo.worktrees.map((w) => this.read(w.path)),
    );

    const statusList = statuses
      .map((s) => s?.status)
      .filter((s): s is SessionStatus => s !== undefined);

    if (statusList.includes("waiting")) {
      return { status: "waiting", indicator: "!" };
    }
    if (statusList.includes("busy")) {
      return { status: "busy", indicator: "●" };
    }
    if (statusList.includes("idle")) {
      return { status: "idle", indicator: "○" };
    }
    return { status: null, indicator: "" };
  }

  // Get status for all tracked sessions
  async getAllStatuses(): Promise<Array<{ name: string; data: SessionStatusData }>> {
    const sessions = await getTmuxSessions(this.pi);
    const results: Array<{ name: string; data: SessionStatusData }> = [];

    for (const sessionName of sessions) {
      const status = await getSessionOption(this.pi, sessionName, "@pi-status");
      if (!status || !["idle", "busy", "waiting"].includes(status)) {
        continue;
      }

      const lastUpdatedStr = await getSessionOption(
        this.pi,
        sessionName,
        "@pi-lastUpdated",
      );
      const worktreePath = await getSessionOption(
        this.pi,
        sessionName,
        "@pi-worktree",
      );

      results.push({
        name: sessionName,
        data: {
          status: status as SessionStatus,
          lastUpdated: lastUpdatedStr ? parseInt(lastUpdatedStr, 10) : Date.now(),
          worktreePath: worktreePath || "",
        },
      });
    }

    // Sort by last updated, newest first
    results.sort((a, b) => b.data.lastUpdated - a.data.lastUpdated);

    return results;
  }

  // Initialize on session start
  async initialize(): Promise<boolean> {
    const { getCurrentWorktreePath } = await import("./git.ts");
    const worktreePath = await getCurrentWorktreePath(this.pi);
    if (!worktreePath) return false;

    this.currentWorktreePath = worktreePath;
    await this.write("idle");
    return true;
  }
}
