import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { startPolling, stopPolling, getLastWaitingCount, getLastWaitingRepos } from "../polling.ts";
import type { SessionStatus } from "../types.ts";

let statusBarVisible = false;
let currentPi: ExtensionAPI | null = null;
let currentCtx: ExtensionCommandContext | null = null;
let currentWaitingCount = 0;
let currentWaitingRepos: string[] = [];

// Start the global status bar polling
export function startStatusBar(pi: ExtensionAPI, ctx?: ExtensionCommandContext): void {
  if (currentPi === pi && statusBarVisible) return;
  
  currentPi = pi;
  if (ctx) currentCtx = ctx;
  statusBarVisible = true;

  startPolling(pi, {
    intervalMs: 5000,
    onWaitingChange: (count, repos) => {
      currentWaitingCount = count;
      currentWaitingRepos = repos;
      
      // Update the status bar display if we have a context
      if (ctx) {
        updateStatusBarDisplay(ctx, count, repos);
      }
    },
  });
}

// Stop the status bar polling
export function stopStatusBar(ctx?: ExtensionCommandContext): void {
  statusBarVisible = false;
  stopPolling();
  // Clear the status from the footer
  if (ctx) {
    ctx.ui.setStatus("wt-statusbar", undefined);
  }
  currentPi = null;
  currentCtx = null;
}

// Update the status bar display (called from commands with ctx)
export function updateStatusBarDisplay(
  ctx: ExtensionCommandContext,
  count: number,
  repos: string[],
): void {
  if (!statusBarVisible) return;

  const theme = ctx.ui.theme;

  if (count === 0) {
    // Hide status bar when no waiting repos
    ctx.ui.setStatus("wt-statusbar", undefined);
    return;
  }

  const repoList = repos.slice(0, 3).join(", ");
  const more = repos.length > 3 ? ` +${repos.length - 3} more` : "";
  const message = `⚠ ${count} waiting: ${repoList}${more}`;

  // Use warning color for waiting status - shown in the footer status bar
  const styledMessage = theme.fg("warning", message);

  ctx.ui.setStatus("wt-statusbar", styledMessage);
}

// Get current status summary for commands
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

// Manual refresh of status bar from command context
export async function refreshStatusBar(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  const { StatusService } = await import("../status.ts");
  const { discoverRepos } = await import("../git.ts");
  
  const statusService = new StatusService(pi);
  const repos = await discoverRepos(pi);
  
  let waitingCount = 0;
  const waitingRepos: string[] = [];

  for (const repo of repos) {
    const { indicator } = await statusService.getRepoStatus(repo);
    if (indicator === "!") {
      waitingCount++;
      waitingRepos.push(repo.name);
    }
  }

  updateStatusBarDisplay(ctx, waitingCount, waitingRepos);
}
