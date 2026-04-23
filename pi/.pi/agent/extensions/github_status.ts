/**
 * GitHub Status Extension
 *
 * Check CI/CD status on the current commit/PR and send fix requests to the agent.
 * Currently supports GitHub Actions; designed to be extensible for additional
 * status check sources (CircleCI, Travis, etc.) in the future.
 *
 * Commands:
 *   /github-status     - Show GitHub Actions check status and select job to fix
 *
 * Usage:
 *   /github-status     - Open status picker for current commit/PR
 *
 * Requirements:
 *   - gh CLI installed and authenticated
 *   - Inside a git repository with GitHub remote
 */

import { spawnSync } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";

// ============================================================================
// Types
// ============================================================================

interface StatusCheck {
  id: string;
  name: string;
  status: "pending" | "success" | "failure" | "cancelled" | "skipped" | "unknown";
  conclusion?: string;
  url?: string;
  source: StatusSource;
}

interface StatusSource {
  name: string;
  type: "github-actions" | "github-checks" | "other";
}

interface PRInfo {
  number: number;
  title: string;
  url: string;
  branch: string;
}

interface CommitInfo {
  sha: string;
  shortSha: string;
  message: string;
}

interface StatusContext {
  commit: CommitInfo;
  pr: PRInfo | null;
  checks: StatusCheck[];
}

// ============================================================================
// Status Source Interface
// ============================================================================

interface StatusSourceProvider {
  name: string;
  isAvailable(): Promise<boolean>;
  fetchStatus(commitSha: string, cwd: string): Promise<StatusCheck[]>;
}

// ============================================================================
// GitHub Actions Status Provider
// ============================================================================

const githubActionsProvider: StatusSourceProvider = {
  name: "GitHub Actions",

  async isAvailable(): Promise<boolean> {
    const result = spawnSync("which", ["gh"], { encoding: "utf8" });
    return result.status === 0;
  },

  async fetchStatus(commitSha: string, cwd: string): Promise<StatusCheck[]> {
    // Get workflow runs for this commit
    const runsResult = spawnSync(
      "gh",
      [
        "run",
        "list",
        "--commit",
        commitSha,
        "--json",
        "databaseId,workflowName,status,conclusion,event,headBranch,url",
        "-L",
        "50",
      ],
      {
        encoding: "utf8",
        cwd,
        env: process.env,
      }
    );

    if (runsResult.status !== 0 || !runsResult.stdout) {
      return [];
    }

    try {
      const runs = JSON.parse(runsResult.stdout);
      const checks: StatusCheck[] = [];

      for (const run of runs) {
        // Fetch jobs for this workflow run
        const jobsResult = spawnSync(
          "gh",
          [
            "run",
            "view",
            String(run.databaseId),
            "--json",
            "jobs",
          ],
          {
            encoding: "utf8",
            cwd,
            env: process.env,
          }
        );

        if (jobsResult.status === 0 && jobsResult.stdout) {
          try {
            const { jobs } = JSON.parse(jobsResult.stdout);
            for (const job of jobs || []) {
              checks.push({
                id: `gha-${run.databaseId}-${job.name}`,
                name: `${run.workflowName} / ${job.name}`,
                status: mapGitHubStatus(job.status, job.conclusion),
                conclusion: job.conclusion,
                url: job.url || run.url,
                source: { name: "GitHub Actions", type: "github-actions" },
              });
            }
          } catch {
            // If job parsing fails, add the workflow as a single check
            checks.push({
              id: `gha-${run.databaseId}`,
              name: run.workflowName,
              status: mapGitHubStatus(run.status, run.conclusion),
              conclusion: run.conclusion,
              url: run.url,
              source: { name: "GitHub Actions", type: "github-actions" },
            });
          }
        } else {
          // If we can't get jobs, add the workflow as a single check
          checks.push({
            id: `gha-${run.databaseId}`,
            name: run.workflowName,
            status: mapGitHubStatus(run.status, run.conclusion),
            conclusion: run.conclusion,
            url: run.url,
            source: { name: "GitHub Actions", type: "github-actions" },
          });
        }
      }

      return checks;
    } catch {
      return [];
    }
  },
};

function mapGitHubStatus(
  status: string,
  conclusion: string | null
): StatusCheck["status"] {
  if (status === "queued" || status === "in_progress" || status === "waiting") {
    return "pending";
  }
  if (status === "completed") {
    if (conclusion === "success") return "success";
    if (conclusion === "failure") return "failure";
    if (conclusion === "cancelled" || conclusion === "timed_out") return "cancelled";
    if (conclusion === "skipped" || conclusion === "neutral") return "skipped";
  }
  return "unknown";
}

// ============================================================================
// GitHub Checks API Provider (for non-Actions checks)
// ============================================================================

const githubChecksProvider: StatusSourceProvider = {
  name: "GitHub Checks",

  async isAvailable(): Promise<boolean> {
    const result = spawnSync("which", ["gh"], { encoding: "utf8" });
    return result.status === 0;
  },

  async fetchStatus(commitSha: string, cwd: string): Promise<StatusCheck[]> {
    // Get combined commit status and check runs
    const checksResult = spawnSync(
      "gh",
      [
        "api",
        `repos/{owner}/{repo}/commits/${commitSha}/check-runs`,
        "--jq",
        ".check_runs[] | select(.app.slug != "github-actions") | {id, name, status, conclusion, html_url}",
      ],
      {
        encoding: "utf8",
        cwd,
        env: process.env,
      }
    );

    if (checksResult.status !== 0 || !checksResult.stdout) {
      return [];
    }

    try {
      const checks: StatusCheck[] = [];
      const lines = checksResult.stdout.trim().split("\n").filter(Boolean);

      for (const line of lines) {
        try {
          const check = JSON.parse(line);
          checks.push({
            id: `check-${check.id}`,
            name: check.name,
            status: mapGitHubStatus(check.status, check.conclusion),
            conclusion: check.conclusion,
            url: check.html_url,
            source: { name: "GitHub Checks", type: "github-checks" },
          });
        } catch {
          // Skip invalid lines
        }
      }

      return checks;
    } catch {
      return [];
    }
  },
};

// ============================================================================
// Status Manager (aggregates all sources)
// ============================================================================

class StatusManager {
  private providers: StatusSourceProvider[] = [
    githubActionsProvider,
    githubChecksProvider,
  ];

  async fetchAllStatus(commitSha: string, cwd: string): Promise<StatusCheck[]> {
    const allChecks: StatusCheck[] = [];

    for (const provider of this.providers) {
      if (await provider.isAvailable()) {
        try {
          const checks = await provider.fetchStatus(commitSha, cwd);
          allChecks.push(...checks);
        } catch (err) {
          console.error(`[github-status] Failed to fetch from ${provider.name}:`, err);
        }
      }
    }

    return allChecks;
  }

  registerProvider(provider: StatusSourceProvider): void {
    this.providers.push(provider);
  }
}

// ============================================================================
// Git Helpers
// ============================================================================

async function getCurrentCommit(cwd: string): Promise<CommitInfo | null> {
  const result = spawnSync(
    "git",
    ["rev-parse", "HEAD"],
    { encoding: "utf8", cwd }
  );

  if (result.status !== 0 || !result.stdout) {
    return null;
  }

  const sha = result.stdout.trim();
  const shortResult = spawnSync(
    "git",
    ["rev-parse", "--short", "HEAD"],
    { encoding: "utf8", cwd }
  );
  const shortSha = shortResult.status === 0 ? shortResult.stdout.trim() : sha.slice(0, 7);

  const msgResult = spawnSync(
    "git",
    ["log", "-1", "--pretty=%s"],
    { encoding: "utf8", cwd }
  );
  const message = msgResult.status === 0 ? msgResult.stdout.trim() : "Unknown";

  return { sha, shortSha, message };
}

async function getCurrentPR(cwd: string): Promise<PRInfo | null> {
  // Try to get PR info for current branch
  const result = spawnSync(
    "gh",
    ["pr", "view", "--json", "number,title,url,headRefName"],
    { encoding: "utf8", cwd, env: process.env }
  );

  if (result.status !== 0 || !result.stdout) {
    return null;
  }

  try {
    const pr = JSON.parse(result.stdout);
    return {
      number: pr.number,
      title: pr.title,
      url: pr.url,
      branch: pr.headRefName,
    };
  } catch {
    return null;
  }
}

// ============================================================================
// UI Helpers
// ============================================================================

function getStatusIcon(status: StatusCheck["status"]): string {
  switch (status) {
    case "success":
      return "✓";
    case "failure":
      return "✗";
    case "pending":
      return "○";
    case "cancelled":
      return "⊘";
    case "skipped":
      return "⊝";
    default:
      return "?";
  }
}

function getStatusColor(
  status: StatusCheck["status"],
  theme: import("@mariozechner/pi-coding-agent").ThemeAPI
): string {
  switch (status) {
    case "success":
      return theme.fg("success", getStatusIcon(status));
    case "failure":
      return theme.fg("error", getStatusIcon(status));
    case "pending":
      return theme.fg("warning", getStatusIcon(status));
    case "cancelled":
      return theme.fg("dim", getStatusIcon(status));
    case "skipped":
      return theme.fg("dim", getStatusIcon(status));
    default:
      return theme.fg("dim", getStatusIcon(status));
  }
}

// ============================================================================
// Status Picker UI
// ============================================================================

async function showStatusPicker(
  ctx: ExtensionCommandContext,
  statusContext: StatusContext
): Promise<StatusCheck | null> {
  const items = statusContext.checks.map((check) => ({
    value: check.id,
    label: check.name,
    description: `${getStatusIcon(check.status)} ${check.source.name}`,
    check,
  }));

  if (items.length === 0) {
    ctx.ui.notify("No status checks found", "info");
    return null;
  }

  return new Promise((resolve) => {
    ctx.ui.custom<StatusCheck | null>((tui, theme, _kb, done) => {
      let selectedIndex = 0;
      let filteredItems = [...items];
      let filterText = "";
      let cachedLines: string[] | undefined;

      function updateFilter(): void {
        if (!filterText) {
          filteredItems = [...items];
        } else {
          const lower = filterText.toLowerCase();
          filteredItems = items.filter(
            (i) =>
              i.label.toLowerCase().includes(lower) ||
              i.description.toLowerCase().includes(lower)
          );
        }
        selectedIndex = Math.min(selectedIndex, filteredItems.length - 1);
        if (selectedIndex < 0) selectedIndex = 0;
        cachedLines = undefined;
      }

      function render(width: number): string[] {
        if (cachedLines) return cachedLines;

        const lines: string[] = [];
        const add = (s: string) => lines.push(truncateToWidth(s, width));

        // Header
        const headerText = statusContext.pr
          ? `PR #${statusContext.pr.number}: ${statusContext.pr.title}`
          : `Commit ${statusContext.commit.shortSha}: ${statusContext.commit.message.slice(0, 40)}${statusContext.commit.message.length > 40 ? "..." : ""}`;
        add(theme.fg("accent", "─".repeat(width)));
        add(theme.fg("accent", theme.bold(` GitHub Status: ${headerText} `)));
        add(theme.fg("accent", "─".repeat(width)));
        lines.push("");

        // Filter input
        add(`  Filter: ${filterText}_`);
        lines.push("");

        // Items
        const maxVisible = Math.min(10, filteredItems.length);
        const startIdx = Math.max(0, Math.min(selectedIndex - 5, filteredItems.length - maxVisible));
        const endIdx = Math.min(startIdx + maxVisible, filteredItems.length);

        for (let i = startIdx; i < endIdx; i++) {
          const item = filteredItems[i];
          const isSelected = i === selectedIndex;
          const prefix = isSelected ? theme.fg("accent", "> ") : "  ";
          const statusColored = getStatusColor(item.check.status, theme);
          const name = isSelected
            ? theme.fg("accent", theme.bold(item.label))
            : theme.fg("text", item.label);
          const source = theme.fg("dim", `(${item.check.source.name})`);
          add(`${prefix}${statusColored} ${name} ${source}`);
        }

        if (filteredItems.length === 0) {
          add(theme.fg("dim", "  No matching checks"));
        }

        lines.push("");
        add(theme.fg("accent", "─".repeat(width)));
        add(theme.fg("dim", "  Type to filter • ↑↓ navigate • Enter to select • Esc to cancel"));
        add(theme.fg("accent", "─".repeat(width)));

        cachedLines = lines;
        return lines;
      }

      function confirmSelection(): void {
        if (filteredItems.length > 0 && selectedIndex >= 0) {
          done(filteredItems[selectedIndex].check);
        } else {
          done(null);
        }
      }

      return {
        render,
        invalidate: () => {
          cachedLines = undefined;
        },
        handleInput: (data: string) => {
          // Escape to cancel
          if (data === "\x1b") {
            done(null);
            return;
          }

          // Enter to confirm
          if (data === "\r") {
            confirmSelection();
            return;
          }

          // Navigation
          if (data === "\x1b[A" || data === "\x1bOA") {
            // Up arrow
            if (selectedIndex > 0) {
              selectedIndex--;
              cachedLines = undefined;
              tui.requestRender();
            }
            return;
          }

          if (data === "\x1b[B" || data === "\x1bOB") {
            // Down arrow
            if (selectedIndex < filteredItems.length - 1) {
              selectedIndex++;
              cachedLines = undefined;
              tui.requestRender();
            }
            return;
          }

          // Backspace
          if (data === "\x7f" || data === "\x08") {
            if (filterText.length > 0) {
              filterText = filterText.slice(0, -1);
              updateFilter();
              tui.requestRender();
            }
            return;
          }

          // Printable characters
          if (data.length === 1 && data.charCodeAt(0) >= 32 && data.charCodeAt(0) < 127) {
            filterText += data;
            updateFilter();
            tui.requestRender();
            return;
          }
        },
        focused: false,
      };
    }).then(resolve);
  });
}

// ============================================================================
// Main Command Handler
// ============================================================================

async function githubStatusCommand(
  _pi: ExtensionAPI,
  ctx: ExtensionCommandContext
): Promise<void> {
  // Check prerequisites
  const ghCheck = spawnSync("which", ["gh"], { encoding: "utf8" });
  if (ghCheck.status !== 0) {
    ctx.ui.notify("gh CLI is not installed. Install with: brew install gh", "error");
    return;
  }

  const gitCheck = spawnSync("which", ["git"], { encoding: "utf8" });
  if (gitCheck.status !== 0) {
    ctx.ui.notify("git is not installed", "error");
    return;
  }

  // Get commit info
  ctx.ui.notify("Fetching commit information...", "info");
  const commit = await getCurrentCommit(ctx.cwd);
  if (!commit) {
    ctx.ui.notify("Failed to get current commit. Are you in a git repository?", "error");
    return;
  }

  // Get PR info
  ctx.ui.notify("Fetching PR information...", "info");
  const pr = await getCurrentPR(ctx.cwd);

  // Fetch status checks
  ctx.ui.notify("Fetching status checks...", "info");
  const statusManager = new StatusManager();
  const checks = await statusManager.fetchAllStatus(commit.sha, ctx.cwd);

  const statusContext: StatusContext = {
    commit,
    pr,
    checks,
  };

  if (checks.length === 0) {
    ctx.ui.notify("No status checks found for this commit", "info");
    return;
  }

  // Show picker
  const selected = await showStatusPicker(ctx, statusContext);

  if (!selected) {
    ctx.ui.notify("No job selected", "info");
    return;
  }

  // Only allow fixing failed jobs
  if (selected.status !== "failure" && selected.status !== "cancelled") {
    ctx.ui.notify(`Job "${selected.name}" is not in a failed state (${selected.status})`, "warning");
    return;
  }

  // Send fix message to agent
  const jobName = selected.name;
  const prRef = pr ? `PR #${pr.number}` : `commit ${commit.shortSha}`;
  const fixMessage = `fix job "${jobName}" on ${prRef}`;

  ctx.ui.notify(`Requesting fix for: ${jobName}`, "info");

  // Send the message to the agent by simulating user input
  // This uses the agent's message API
  await ctx.agent.sendMessage(fixMessage);
}

// ============================================================================
// Extension Entry Point
// ============================================================================

export default function (pi: ExtensionAPI) {
  // /github-status - Check GitHub Actions status and request fixes
  pi.registerCommand("github-status", {
    description: "Check GitHub Actions status and select a failed job to fix",
    handler: async (_args, ctx) => {
      try {
        await githubStatusCommand(pi, ctx);
      } catch (err) {
        console.error("[github-status] Error:", err);
        ctx.ui.notify(
          `Error: ${err instanceof Error ? err.message : String(err)}`,
          "error"
        );
      }
    },
  });

  // Notify on load
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("GitHub Status extension ready: /github-status", "info");
  });
}
