/**
 * GitHub Status Extension
 *
 * Shows failing CI/CD checks and merge conflicts for the current commit/PR,
 * allowing you to quickly identify and request fixes for problems.
 * Only displays issues (failures, cancellations, merge conflicts) - clean
 * and pending statuses are filtered out.
 *
 * Commands:
 *   /github-status     - Show failing checks and merge conflicts
 *
 * Usage:
 *   /github-status     - Open status picker with only problem items
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
        `.check_runs[] | select(.app.slug != \"github-actions\") | {id, name, status, conclusion, html_url}`,
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
// Merge Conflict Status Provider
// ============================================================================

const mergeConflictProvider: StatusSourceProvider = {
  name: "Merge Conflict Check",

  async isAvailable(): Promise<boolean> {
    const result = spawnSync("which", ["git"], { encoding: "utf8" });
    return result.status === 0;
  },

  async fetchStatus(_commitSha: string, cwd: string): Promise<StatusCheck[]> {
    // Get current branch name
    const branchResult = spawnSync(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { encoding: "utf8", cwd }
    );

    if (branchResult.status !== 0 || !branchResult.stdout) {
      return [];
    }

    const currentBranch = branchResult.stdout.trim();

    // Skip if we're on master/main
    if (currentBranch === "master" || currentBranch === "main") {
      return [];
    }

    // Determine default branch (master or main)
    const defaultBranchResult = spawnSync(
      "git",
      ["rev-parse", "--abbrev-ref", "origin/HEAD"],
      { encoding: "utf8", cwd }
    );

    let defaultBranch = "master";
    if (defaultBranchResult.status === 0 && defaultBranchResult.stdout) {
      const ref = defaultBranchResult.stdout.trim();
      if (ref.includes("/")) {
        defaultBranch = ref.split("/").pop() || "master";
      }
    } else {
      // Fallback: check if origin/main exists
      const mainCheck = spawnSync(
        "git",
        ["rev-parse", "--verify", "origin/main"],
        { encoding: "utf8", cwd }
      );
      if (mainCheck.status === 0) {
        defaultBranch = "main";
      }
    }

    // Check for merge conflicts by attempting a merge --no-commit --no-ff
    // First, fetch the latest default branch
    spawnSync(
      "git",
      ["fetch", "origin", defaultBranch],
      { encoding: "utf8", cwd }
    );

    // Check if merge would conflict
    const mergeCheckResult = spawnSync(
      "git",
      ["merge-tree", `origin/${defaultBranch}`, currentBranch],
      { encoding: "utf8", cwd }
    );

    if (mergeCheckResult.status !== 0) {
      // Command failed, try alternative approach
      // Use git merge --no-commit --no-ff and check exit status
      // Stash any local changes first
      const stashResult = spawnSync(
        "git",
        ["stash", "push", "-m", "github-status-merge-check"],
        { encoding: "utf8", cwd }
      );

      const hadChanges = stashResult.status === 0 && !stashResult.stdout?.includes("No local changes");

      // Try the merge
      const mergeResult = spawnSync(
        "git",
        ["merge", `origin/${defaultBranch}`, "--no-commit", "--no-ff"],
        { encoding: "utf8", cwd }
      );

      const hasConflict = mergeResult.status !== 0 ||
        mergeResult.stdout?.includes("CONFLICT") ||
        mergeResult.stderr?.includes("CONFLICT");

      // Abort the merge attempt
      spawnSync("git", ["merge", "--abort"], { encoding: "utf8", cwd });

      // Restore stashed changes if any
      if (hadChanges) {
        spawnSync("git", ["stash", "pop"], { encoding: "utf8", cwd });
      }

      if (hasConflict) {
        return [{
          id: `merge-conflict-${currentBranch}`,
          name: `Merge Conflict with ${defaultBranch}`,
          status: "failure",
          conclusion: "merge_conflict",
          url: undefined,
          source: { name: "Git", type: "other" },
        }];
      }
    } else {
      // Check merge-tree output for conflicts
      const output = mergeCheckResult.stdout || "";
      if (output.includes("conflict") || output.includes("<<<")) {
        return [{
          id: `merge-conflict-${currentBranch}`,
          name: `Merge Conflict with ${defaultBranch}`,
          status: "failure",
          conclusion: "merge_conflict",
          url: undefined,
          source: { name: "Git", type: "other" },
        }];
      }
    }

    // No conflicts found - return empty (we only want to show problems)
    return [];
  },
};

// ============================================================================
// Status Manager (aggregates all sources)
// ============================================================================

class StatusManager {
  private providers: StatusSourceProvider[] = [
    githubActionsProvider,
    githubChecksProvider,
    mergeConflictProvider,
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

    // Filter to only show problems (failures, cancellations, merge conflicts)
    // Skip success and pending statuses
    return allChecks.filter((check) =>
      check.status === "failure" ||
      check.status === "cancelled" ||
      check.status === "unknown" ||
      check.conclusion === "merge_conflict"
    );
  }

  registerProvider(provider: StatusSourceProvider): void {
    this.providers.push(provider);
  }

  getProviders(): StatusSourceProvider[] {
    return [...this.providers];
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
// Status Picker UI (Reactive - updates as results arrive)
// ============================================================================

interface PickerItem {
  value: string;
  label: string;
  description: string;
  check: StatusCheck;
}

interface LoadingState {
  providers: Map<string, boolean>;
  complete: boolean;
}

async function showStatusPicker(
  ctx: ExtensionCommandContext,
  statusContext: StatusContext,
  loadingState: LoadingState
): Promise<StatusCheck | null> {
  // Mutable items array - can be updated as results arrive
  let items: PickerItem[] = statusContext.checks.map((check) => ({
    value: check.id,
    label: check.name,
    description: `${getStatusIcon(check.status)} ${check.source.name}`,
    check,
  }));

  return new Promise((resolve) => {
    ctx.ui.custom<StatusCheck | null>((tui, theme, _kb, done) => {
      let selectedIndex = 0;
      let filteredItems: PickerItem[] = [...items];
      let filterText = "";
      let cachedLines: string[] | undefined;

      // Track last seen check count to detect changes
      let lastCheckCount = statusContext.checks.length;

      // Function to sync items with current statusContext and refresh display
      function syncItems(): void {
        const newItems = statusContext.checks.map((check) => ({
          value: check.id,
          label: check.name,
          description: `${getStatusIcon(check.status)} ${check.source.name}`,
          check,
        }));

        // Preserve selection if possible
        const currentValue = filteredItems[selectedIndex]?.value;
        items = newItems;
        updateFilter();

        // Try to restore selection
        if (currentValue) {
          const newIndex = filteredItems.findIndex((i) => i.value === currentValue);
          if (newIndex >= 0) {
            selectedIndex = newIndex;
          }
        }

        lastCheckCount = statusContext.checks.length;
        cachedLines = undefined;
        tui.requestRender();
      }

      // Poll for changes every 300ms while loading
      const pollInterval = setInterval(() => {
        if (statusContext.checks.length !== lastCheckCount || !loadingState.complete) {
          syncItems();
        }
        if (loadingState.complete) {
          clearInterval(pollInterval);
        }
      }, 300);

      // Wrap done to ensure cleanup
      const originalDone = done;
      const wrappedDone = (result: StatusCheck | null) => {
        clearInterval(pollInterval);
        originalDone(result);
      };
      done = wrappedDone;

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
          // Check if still loading
          const loadingCount = Array.from(loadingState.providers.values()).filter(Boolean).length;
          if (loadingCount > 0 || !loadingState.complete) {
            add(theme.fg("warning", "  ○ Scanning for issues..."));
            const loadingNames = Array.from(loadingState.providers.entries())
              .filter(([_, loading]) => loading)
              .map(([name, _]) => name);
            if (loadingNames.length > 0) {
              add(theme.fg("dim", `    Checking: ${loadingNames.join(", ")}`));
            }
          } else {
            add(theme.fg("success", "  ✓ All clear! No issues found."));
          }
        }

        lines.push("");
        add(theme.fg("accent", "─".repeat(width)));
        if (loadingState.complete) {
          add(theme.fg("dim", "  Type to filter • ↑↓ navigate • Enter to select • Esc to cancel"));
        } else {
          const remaining = Array.from(loadingState.providers.values()).filter(Boolean).length;
          add(theme.fg("dim", `  Scanning ${remaining} sources... • ↑↓ navigate • Enter to select • Esc to cancel`));
        }
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
  pi: ExtensionAPI,
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

  // Get commit info (fast - do first)
  const commit = await getCurrentCommit(ctx.cwd);
  if (!commit) {
    ctx.ui.notify("Failed to get current commit. Are you in a git repository?", "error");
    return;
  }

  // Get PR info (fast)
  const pr = await getCurrentPR(ctx.cwd);

  // Create mutable status context - starts empty, populates as results arrive
  const statusContext: StatusContext = {
    commit,
    pr,
    checks: [],
  };

  // Track loading state
  const loadingState: LoadingState = {
    providers: new Map([
      ["GitHub Actions", true],
      ["GitHub Checks", true],
      ["Merge Conflict Check", true],
    ]),
    complete: false,
  };

  // Create status manager for background fetching
  const statusManager = new StatusManager();

  // Start background fetch immediately - will populate statusContext.checks
  const fetchPromise = (async () => {
    for (const provider of statusManager.getProviders()) {
      if (await provider.isAvailable()) {
        try {
          const checks = await provider.fetchStatus(commit.sha, ctx.cwd);
          // Only add failure/problem checks
          const problemChecks = checks.filter((check) =>
            check.status === "failure" ||
            check.status === "cancelled" ||
            check.status === "unknown" ||
            check.conclusion === "merge_conflict"
          );
          statusContext.checks.push(...problemChecks);
        } catch (err) {
          console.error(`[github-status] Failed to fetch from ${provider.name}:`, err);
        }
      }
      loadingState.providers.set(provider.name, false);
    }
    loadingState.complete = true;
  })();

  // Show picker immediately - it will start empty and populate as results arrive
  const selected = await showStatusPicker(ctx, statusContext, loadingState);

  // Wait for fetch to complete in case picker closed early
  await fetchPromise;

  if (!selected) {
    ctx.ui.notify("No job selected", "info");
    return;
  }

  // Build fix request based on issue type
  const jobName = selected.name;
  const prRef = pr ? `PR #${pr.number}` : `commit ${commit.shortSha}`;
  const prContext = pr
    ? `PR: ${pr.title} (#${pr.number}) on branch "${pr.branch}"`
    : `Commit: ${commit.message} (${commit.shortSha})`;

  // Check if this is a merge conflict
  const isMergeConflict = selected.conclusion === "merge_conflict";

  const fixMessage = isMergeConflict
    ? `🔧 Resolve Merge Conflict

**Issue:** ${jobName}
${prContext}

This branch has merge conflicts that must be resolved before it can be merged.

Please resolve the merge conflicts by following these steps:

1. **Check current branch**: Make sure you're on the correct branch
   \`git branch --show-current\`

2. **Attempt the merge locally**:
   \`git fetch origin\`
   \`git merge origin/master\` (or \`origin/main\` if that's your default)

3. **Identify conflicting files**:
   \`git status\` will show files with conflicts marked as "Unmerged"

4. **Resolve each conflict**:
   - Open each conflicting file
   - Look for conflict markers: \`<<<<<<<\`, \`=======\`, \`>>>>>>>\`
   - Decide which changes to keep (yours, theirs, or a combination)
   - Remove the conflict markers
   - Save the file

5. **Mark as resolved**:
   \`git add <resolved-file>\` for each file
   \`git commit\` to complete the merge (use the default message)

6. **Push the resolved branch**:
   \`git push\`

Tips:
- If you're unsure about a conflict, check with the author of the conflicting commit
- Use \`git mergetool\` if you have a preferred merge tool configured
- You can abort the merge at any time with \`git merge --abort\` if needed

Focus on resolving conflicts while preserving the intended logic from both branches.`
    : `🔧 Fix GitHub Actions Job Failure

**Failed Job:** "${jobName}"
**Status:** ${selected.status}${selected.conclusion ? ` (${selected.conclusion})` : ""}
${prContext}
${selected.url ? `**Job URL:** ${selected.url}` : ""}

Please investigate and fix this failing CI job. Follow these steps:

1. **Fetch logs**: Get the detailed logs for this specific job using 
   \`gh run view --job=<job-id> --log\` or browse to the job URL above

2. **Analyze the failure**: 
   - Identify the root cause (test failure, build error, dependency issue, etc.)
   - Check if it's a transient issue or a real code problem
   - Look for error messages, stack traces, or configuration issues

3. **Identify the fix**:
   - If it's a code issue: fix the underlying problem in the codebase
   - If it's a flaky test: consider retry logic or test improvements
   - If it's a dependency issue: update lockfiles or dependencies
   - If it's a configuration issue: check workflow files in .github/workflows/

4. **Verify locally** (if possible):
   - Try to reproduce the failure locally
   - Run relevant tests or build commands

5. **Commit the fix** with a clear message explaining what was wrong

Focus on finding the minimal fix needed to make this job pass.`;

  ctx.ui.notify(`Requesting fix for: ${jobName}`, "info");

  // Switch to appropriate model for the fix type
  const originalModel = ctx.getModel();
  const targetModelId = isMergeConflict
    ? "anthropic/claude-sonnet-4-20250514"  // Merge conflicts need careful reasoning
    : "accounts/fireworks/routers/kimi-k2p5-turbo";  // CI failures need speed + code analysis

  try {
    // Try to switch to the target model
    const modelSwitched = await pi.setModel(targetModelId as any);
    if (modelSwitched) {
      ctx.ui.notify(
        `Switched to ${isMergeConflict ? "Claude Sonnet" : "Kimi K2.5 Turbo"} for this ${isMergeConflict ? "merge conflict" : "CI failure"} fix`,
        "info"
      );
    }

    // Send the message
    pi.sendUserMessage(fixMessage);

    // Restore original model after a brief delay (give the agent time to start processing)
    if (originalModel && modelSwitched) {
      setTimeout(() => {
        pi.setModel(originalModel).catch(() => {
          // Ignore restore errors
        });
      }, 1000);
    }
  } catch (err) {
    // If model switching fails, just send the message with current model
    console.error("[github-status] Failed to switch model:", err);
    pi.sendUserMessage(fixMessage);
  }
}

// ============================================================================
// Extension Entry Point
// ============================================================================

export default function (pi: ExtensionAPI) {
  // /github-status - Show failing checks and merge conflicts
  pi.registerCommand("github-status", {
    description: "Show failing CI checks and merge conflicts for the current branch",
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
