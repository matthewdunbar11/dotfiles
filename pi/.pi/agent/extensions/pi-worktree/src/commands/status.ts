import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { StatusService } from "../status.ts";

// /wt-status command handler
export async function statusCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const theme = ctx.ui.theme;
  const statusService = new StatusService(pi);

  try {
    const statuses = await statusService.getAllStatuses();

    if (statuses.length === 0) {
      ctx.ui.notify("No tracked pi sessions found in tmux", "info");
      return;
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
        return `  ${theme.fg("text", s.name.padEnd(30))} ${theme.fg(statusColor, s.data.status.padEnd(8))} ${theme.fg("dim", ageStr)}`;
      }),
    ];

    ctx.ui.setWidget("wt-status", lines);
    ctx.ui.notify(`Tracked ${statuses.length} pi session(s)`, "info");
  } catch (err) {
    ctx.ui.notify(`Failed to read status: ${err}`, "error");
  }
}
