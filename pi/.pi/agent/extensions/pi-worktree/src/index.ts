import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { worktreeCommand } from "./commands/worktree.ts";
import { statusCommand } from "./commands/status.ts";
import { StatusService } from "./status.ts";
import { getCurrentWorktreePath } from "./git.ts";
import { startStatusBar, stopStatusBar, getStatusSummary, refreshStatusBar } from "./ui/status-bar.ts";

let statusBarEnabled = true;

// Main extension entry point
export default function (pi: ExtensionAPI) {
  const statusService = new StatusService(pi);

  // Status tracking: session start
  pi.on("session_start", async (_event, ctx) => {
    const initialized = await statusService.initialize();
    if (initialized) {
      const sessionName = await import("./tmux.ts").then((m) => m.getCurrentSession(pi));
      ctx.ui.notify(`Status tracking: ${sessionName}`, "info");
      
      // Auto-start status bar polling (enabled by default)
      if (statusBarEnabled) {
        startStatusBar(pi, ctx);
      }
    }
  });

  // Status tracking: agent starts (user sent prompt)
  pi.on("agent_start", async () => {
    await statusService.write("busy");
  });

  // Status tracking: agent ends
  pi.on("agent_end", async () => {
    await statusService.write("waiting");
  });

  // Status tracking: user interacts - transition from waiting to idle
  pi.on("input", async () => {
    const currentStatus = await statusService.getStatus();
    if (currentStatus === "waiting") {
      await statusService.write("idle");
    }
    return { action: "continue" };
  });

  // Start status bar polling on load (will show notifications when commands run)
  // Note: Status bar widget display requires command context, so we set it up
  // but the widget will only appear after first command runs

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
        await refreshStatusBar(pi, ctx);
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
      // Refresh and get current status
      await refreshStatusBar(pi, ctx);
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
