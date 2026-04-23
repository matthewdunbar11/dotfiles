import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { getGlobalClient } from "../daemon/client.ts";

const client = getGlobalClient();

// /wt-status command handler
export async function statusCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const theme = ctx.ui.theme;

  try {
    // Get all statuses from daemon
    const [statuses, repos] = await Promise.all([
      client.getAllStatuses(),
      client.getRepos(),
    ]);

    if (statuses.length === 0) {
      ctx.ui.notify("No tracked pi sessions found in tmux", "info");
      return;
    }

    // Build worktree -> session name mapping from repos
    const worktreeToName = new Map<string, string>();
    for (const repo of repos) {
      for (const wt of repo.worktrees) {
        // Derive session name from worktree path
        const parts = wt.path.split("/");
        if (wt.path.includes(".worktrees")) {
          const worktreesIndex = parts.indexOf(".worktrees");
          if (worktreesIndex >= 0 && parts.length > worktreesIndex + 2) {
            const repoName = parts[worktreesIndex + 1];
            const worktreeName = parts[worktreesIndex + 2];
            worktreeToName.set(wt.path, `${repoName}-${worktreeName}`);
          }
        } else if (wt.path.includes("Code")) {
          const codeIndex = parts.indexOf("Code");
          if (codeIndex >= 0 && parts.length > codeIndex + 1) {
            worktreeToName.set(wt.path, parts[codeIndex + 1]);
          }
        }
      }
    }

    const lines = [
      theme.fg("accent", theme.bold("Worktree Session Status")),
      "",
      ...statuses.map((s) => {
        const age = Date.now() - s.data.lastUpdated;
        const ageStr =
          age < 60000
            ? "just now"
            : age < 3600000
              ? `${Math.floor(age / 60000)}m ago`
              : `${Math.floor(age / 3600000)}h ago`;
        const statusColor =
          s.data.status === "busy"
            ? "error"
            : s.data.status === "waiting"
              ? "warning"
              : "success";
        const sessionName = worktreeToName.get(s.worktreePath) || s.worktreePath.split("/").pop() || "unknown";
        return `  ${theme.fg("text", sessionName.padEnd(30))} ${theme.fg(statusColor, s.data.status.padEnd(8))} ${theme.fg("dim", ageStr)}`;
      }),
    ];

    ctx.ui.setWidget("wt-status", lines);
    ctx.ui.notify(`Tracked ${statuses.length} pi session(s)`, "info");
  } catch (err) {
    ctx.ui.notify(`Failed to read status: ${err}`, "error");
  }
}
