import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { getGlobalClient, disconnectGlobalClient } from "./daemon/client.ts";
import { worktreeCommand } from "./commands/worktree.ts";
import { statusCommand } from "./commands/status.ts";
import type { SessionStatus } from "./types.ts";

let statusBarEnabled = true;
let currentStatus: SessionStatus = "idle";
let client = getGlobalClient();

// Status tracking - write directly via tmux for current session
async function writeStatus(pi: ExtensionAPI, status: SessionStatus): Promise<void> {
  const { getCurrentSession } = await import("./tmux.ts");
  const { getCurrentWorktreePath } = await import("./git.ts");
  const { setSessionOption } = await import("./tmux.ts");
  
  const sessionName = await getCurrentSession(pi);
  const worktreePath = await getCurrentWorktreePath(pi);
  
  if (sessionName && worktreePath) {
    await setSessionOption(pi, sessionName, "@pi-status", status);
    await setSessionOption(pi, sessionName, "@pi-lastUpdated", Date.now().toString());
    await setSessionOption(pi, sessionName, "@pi-worktree", worktreePath);
    currentStatus = status;
  }
}

// Main extension entry point
export default function (pi: ExtensionAPI) {
  // Connect to daemon (starts it if needed)
  client.connect().catch((err) => {
    console.error("[wt] Failed to connect to daemon:", err);
  });

  // Status tracking: session start
  pi.on("session_start", async (_event, ctx) => {
    const { getCurrentSession } = await import("./tmux.ts");
    const sessionName = await getCurrentSession(pi);
    
    // Initialize status in tmux for this session
    await writeStatus(pi, "idle");
    
    if (sessionName) {
      ctx.ui.notify(`Status tracking: ${sessionName}`, "info");
      
      // Auto-start status bar polling
      if (statusBarEnabled) {
        startStatusBar(pi, ctx);
      }
    }
  });

  // Status tracking: agent starts (user sent prompt)
  pi.on("agent_start", async () => {
    await writeStatus(pi, "busy");
  });

  // Status tracking: agent ends
  pi.on("agent_end", async () => {
    await writeStatus(pi, "waiting");
  });

  // Status tracking: user interacts - transition from waiting to idle
  pi.on("input", async () => {
    if (currentStatus === "waiting") {
      await writeStatus(pi, "idle");
    }
    return { action: "continue" };
  });

  // Cleanup on extension unload
  pi.on("unload", () => {
    disconnectGlobalClient();
  });

  // /worktree - full command name
  pi.registerCommand("worktree", {
    description: "Manage git worktrees in tmux sessions",
    handler: async (_args, ctx) => {
      try {
        await worktreeCommand(pi, ctx);
      } catch (err) {
        console.error("[wt] Error in worktree command:", err);
        ctx.ui.notify(`Error: ${err instanceof Error ? err.message : String(err)}`, "error");
        throw err;
      }
    },
  });

  // /wt - short alias
  pi.registerCommand("wt", {
    description: "Alias for /worktree",
    handler: async (_args, ctx) => {
      try {
        await worktreeCommand(pi, ctx);
      } catch (err) {
        console.error("[wt] Error in wt command:", err);
        ctx.ui.notify(`Error: ${err instanceof Error ? err.message : String(err)}`, "error");
        throw err;
      }
    },
  });

  // /wt-status - show status of all tracked pi sessions
  pi.registerCommand("wt-status", {
    description: "Show status of all pi worktree sessions",
    handler: async (_args, ctx) => statusCommand(pi, ctx),
  });

  // /wt-bar - toggle status bar
  pi.registerCommand("wt-bar", {
    description: "Toggle worktree status bar indicator",
    handler: async (_args, ctx) => {
      statusBarEnabled = !statusBarEnabled;
      if (statusBarEnabled) {
        startStatusBar(pi, ctx);
        await refreshStatusBar(ctx);
        ctx.ui.notify("Status bar enabled - watching for waiting worktrees", "success");
      } else {
        stopStatusBar(ctx);
        ctx.ui.setStatus("wt-statusbar", undefined);
        ctx.ui.notify("Status bar disabled", "info");
      }
    },
  });

  // /wt-waiting - list waiting worktrees
  pi.registerCommand("wt-waiting", {
    description: "Show worktrees waiting for review",
    handler: async (_args, ctx) => {
      await refreshStatusBar(ctx);
      const { waitingCount, waitingRepos, hasWaiting } = getStatusSummary();
      
      if (!hasWaiting) {
        ctx.ui.setWidget("wt-waiting", []);
        ctx.ui.notify("No worktrees waiting for review", "info");
        return;
      }

      const theme = ctx.ui.theme;
      const lines = [
        theme.fg("warning", theme.bold(`${waitingCount} worktree(s) waiting for review`)),
        "",
        ...waitingRepos.map(r => `  ! ${theme.fg("text", r)}`),
        "",
        theme.fg("dim", "Use /wt to switch to a waiting worktree"),
      ];

      ctx.ui.setWidget("wt-waiting", lines);
    },
  });
}

// Status bar state
let statusBarVisible = false;
let currentWaitingCount = 0;
let currentWaitingRepos: string[] = [];

function startStatusBar(pi: ExtensionAPI, ctx: ExtensionCommandContext): void {
  if (statusBarVisible) return;
  statusBarVisible = true;

  // Subscribe to waiting count changes from daemon
  client.onWaitingChange((count, repos) => {
    currentWaitingCount = count;
    currentWaitingRepos = repos;
    updateStatusBarDisplay(ctx, count, repos);
  });

  // Initial refresh
  refreshStatusBar(ctx);
}

function stopStatusBar(ctx?: ExtensionCommandContext): void {
  statusBarVisible = false;
  if (ctx) {
    ctx.ui.setStatus("wt-statusbar", undefined);
  }
}

function updateStatusBarDisplay(
  ctx: ExtensionCommandContext,
  count: number,
  repos: string[],
): void {
  if (!statusBarVisible) return;

  const theme = ctx.ui.theme;

  if (count === 0) {
    ctx.ui.setStatus("wt-statusbar", undefined);
    return;
  }

  const repoList = repos.slice(0, 3).join(", ");
  const more = repos.length > 3 ? ` +${repos.length - 3} more` : "";
  const message = `⚠ ${count} waiting: ${repoList}${more}`;
  ctx.ui.setStatus("wt-statusbar", theme.fg("warning", message));
}

export function getStatusSummary(): {
  waitingCount: number;
  waitingRepos: string[];
  hasWaiting: boolean;
} {
  return {
    waitingCount: currentWaitingCount,
    waitingRepos: [...currentWaitingRepos],
    hasWaiting: currentWaitingCount > 0,
  };
}

async function refreshStatusBar(ctx: ExtensionCommandContext): Promise<void> {
  try {
    const statuses = await client.getAllStatuses();
    let waitingCount = 0;
    const waitingRepos = new Set<string>();

    // Get repos to map worktrees to repo names
    const repos = await client.getRepos();
    const worktreeToRepo = new Map<string, string>();
    for (const repo of repos) {
      for (const wt of repo.worktrees) {
        worktreeToRepo.set(wt.path, repo.name);
      }
    }

    for (const { worktreePath, data } of statuses) {
      if (data.status === "waiting") {
        waitingCount++;
        const repoName = worktreeToRepo.get(worktreePath);
        if (repoName) waitingRepos.add(repoName);
      }
    }

    currentWaitingCount = waitingCount;
    currentWaitingRepos = Array.from(waitingRepos);
    updateStatusBarDisplay(ctx, waitingCount, currentWaitingRepos);
  } catch (err) {
    console.error("[wt] Failed to refresh status bar:", err);
  }
}
