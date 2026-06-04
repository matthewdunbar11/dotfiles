/**
 * GitHub CI Status Extension
 *
 * Two-screen modal: pick a commit from a list (with CI status at a glance),
 * then see individual checks for that commit. Select a check to view its
 * logs in a scrollable viewer, then press `f` to send a fix prompt to the LLM.
 *
 * Commands:
 *   /ci          - Browse commits for the current branch
 *   /ci <branch> - Browse commits for a specific branch
 *
 * Requirements:
 *   - gh CLI installed and authenticated
 *   - Inside a git repository with GitHub remote
 */

import { spawnSync } from "node:child_process";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";
import {
  Container,
  type SelectItem,
  SelectList,
  Text,
  visibleWidth,
} from "@mariozechner/pi-tui";
import type { AutocompleteItem } from "@mariozechner/pi-tui";

// ============================================================================
// Types
// ============================================================================

interface CheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  app: { slug: string; name: string };
  details_url: string | null;
  html_url: string | null;
  started_at: string | null;
  completed_at: string | null;
  output: { title: string | null; summary: string | null; text: string | null };
}

interface RepoInfo {
  owner: string;
  repo: string;
}

interface CommitInfo {
  sha: string;
  shortSha: string;
  message: string;
}

interface CommitWithStatus extends CommitInfo {
  status: CommitStatusSummary;
}

interface CommitStatusSummary {
  success: number;
  failure: number;
  pending: number;
  cancelled: number;
  total: number;
}

interface BranchInfo {
  name: string;
  current: boolean;
}

interface PRInfo {
  number: number;
  title: string;
  branch: string;
}

interface WorkflowRun {
  databaseId: number;
  workflowName: string;
  jobName: string;
  jobId: number;
  runUrl: string;
}

// ============================================================================
// Sentinel values returned by modals
// ============================================================================

const SWITCH_BRANCH = "\x00__switch_branch__";
const SEND_FIX = "\x00__send_fix__";

// ============================================================================
// Box-border helper
// ============================================================================

type ThemeAccessor = import("@mariozechner/pi-coding-agent").ThemeAPI;

function withBox(
  innerRender: (innerWidth: number) => string[],
  width: number,
  theme: ThemeAccessor,
): string[] {
  const innerW = Math.max(1, width - 4);
  const content = innerRender(innerW);

  const top = theme.fg("accent", `┌─${"─".repeat(innerW)}─┐`);
  const bottom = theme.fg("accent", `└─${"─".repeat(innerW)}─┘`);

  const middle = content.map((line) => {
    const pad = innerW - visibleWidth(line);
    const padded = pad > 0 ? line + " ".repeat(pad) : line;
    return theme.fg("accent", "│ ") + padded + theme.fg("accent", " │");
  });

  return [top, ...middle, bottom];
}

// ============================================================================
// Helpers – git & gh
// ============================================================================

/** Get the current HEAD commit. */
function getCurrentCommit(cwd: string): CommitInfo | null {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
    cwd,
  });
  if (result.status !== 0 || !result.stdout) return null;
  const sha = result.stdout.trim();
  const shortResult = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
    encoding: "utf8",
    cwd,
  });
  const shortSha =
    shortResult.status === 0 ? shortResult.stdout.trim() : sha.slice(0, 7);
  const msgResult = spawnSync("git", ["log", "-1", "--pretty=%s"], {
    encoding: "utf8",
    cwd,
  });
  const message = msgResult.status === 0 ? msgResult.stdout.trim() : "Unknown";
  return { sha, shortSha, message };
}

/** Get repo owner/name from git remote. */
function getRepoInfo(cwd: string): RepoInfo | null {
  const result = spawnSync("git", ["config", "--get", "remote.origin.url"], {
    encoding: "utf8",
    cwd,
  });
  if (result.status !== 0 || !result.stdout) return null;
  const url = result.stdout.trim();
  let match = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (match) return { owner: match[1], repo: match[2] };
  match = url.match(/github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (match) return { owner: match[1], repo: match[2] };
  return null;
}

/** Get the current branch name. */
function getCurrentBranch(cwd: string): string | null {
  const result = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    encoding: "utf8",
    cwd,
  });
  if (result.status !== 0 || !result.stdout) return null;
  const branch = result.stdout.trim();
  return branch === "HEAD" ? null : branch;
}

/** Get PR info for the current branch. */
function getCurrentPR(cwd: string): PRInfo | null {
  const result = spawnSync(
    "gh",
    ["pr", "view", "--json", "number,title,headRefName"],
    {
      encoding: "utf8",
      cwd,
      env: process.env,
    },
  );
  if (result.status !== 0 || !result.stdout) return null;
  try {
    const pr = JSON.parse(result.stdout);
    return { number: pr.number, title: pr.title, branch: pr.headRefName };
  } catch {
    return null;
  }
}

/** Get PR info for a specific branch. */
function getPRForBranch(
  owner: string,
  repo: string,
  branch: string,
): PRInfo | null {
  const result = spawnSync(
    "gh",
    [
      "api",
      `repos/${owner}/${repo}/pulls?head=${encodeURIComponent(owner)}:${encodeURIComponent(branch)}&state=open&per_page=1`,
      "--jq",
      ".[0] | {number, title, headRefName: .head.ref}",
    ],
    { encoding: "utf8", cwd: process.cwd(), env: process.env },
  );
  if (result.status !== 0 || !result.stdout) return null;
  try {
    const pr = JSON.parse(result.stdout);
    if (!pr.number) return null;
    return { number: pr.number, title: pr.title, branch: pr.headRefName };
  } catch {
    return null;
  }
}

// ============================================================================
// Branch listing
// ============================================================================

function listBranches(
  repoOwner: string,
  repo: string,
  cwd: string,
): BranchInfo[] {
  const currentBranch = getCurrentBranch(cwd);
  const branches: BranchInfo[] = [];
  const result = spawnSync(
    "gh",
    [
      "api",
      `repos/${repoOwner}/${repo}/branches?per_page=100`,
      "--paginate",
      "--jq",
      ".[].name",
    ],
    {
      encoding: "utf8",
      cwd: process.cwd(),
      env: process.env,
      maxBuffer: 5 * 1024 * 1024,
    },
  );
  if (result.status === 0 && result.stdout) {
    const names = result.stdout.trim().split("\n").filter(Boolean);
    const seen = new Set<string>();
    for (const name of names) {
      if (!seen.has(name)) {
        seen.add(name);
        branches.push({ name, current: name === currentBranch });
      }
    }
  }
  branches.sort((a, b) => {
    if (a.current) return -1;
    if (b.current) return 1;
    return a.name.localeCompare(b.name);
  });
  return branches;
}

// ============================================================================
// Commit list helpers
// ============================================================================

const COMMIT_PAGE_SIZE = 30;

function fetchLocalCommits(branch: string, cwd: string): CommitInfo[] {
  const result = spawnSync(
    "git",
    ["log", branch, `-${COMMIT_PAGE_SIZE}`, "--format=%H %s"],
    { encoding: "utf8", cwd, maxBuffer: 1024 * 1024 },
  );
  if (result.status !== 0 || !result.stdout) return [];
  const commits: CommitInfo[] = [];
  for (const line of result.stdout.trim().split("\n").filter(Boolean)) {
    const sha = line.slice(0, 40);
    const message = line.slice(41).trim();
    commits.push({
      sha,
      shortSha: sha.slice(0, 7),
      message: message || "(empty)",
    });
  }
  return commits;
}

function fetchRemoteCommits(
  owner: string,
  repo: string,
  branch: string,
): CommitInfo[] {
  const result = spawnSync(
    "gh",
    [
      "api",
      `repos/${owner}/${repo}/commits?sha=${encodeURIComponent(branch)}&per_page=${COMMIT_PAGE_SIZE}`,
      "--jq",
      ".[] | {sha, message: .commit.message}",
    ],
    {
      encoding: "utf8",
      cwd: process.cwd(),
      env: process.env,
      maxBuffer: 1024 * 1024,
    },
  );
  if (result.status !== 0 || !result.stdout) return [];
  const commits: CommitInfo[] = [];
  for (const line of result.stdout.trim().split("\n").filter(Boolean)) {
    try {
      const data = JSON.parse(line);
      commits.push({
        sha: data.sha,
        shortSha: data.sha.slice(0, 7),
        message: data.message.split("\n")[0] || "(empty)",
      });
    } catch {
      /* skip */
    }
  }
  return commits;
}

function fetchCommitCISummary(
  owner: string,
  repo: string,
  sha: string,
): CommitStatusSummary {
  const result = spawnSync(
    "gh",
    [
      "api",
      `repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=100`,
      "--jq",
      '[.check_runs[] | (.conclusion // "pending")]',
    ],
    {
      encoding: "utf8",
      cwd: process.cwd(),
      env: process.env,
      maxBuffer: 1024 * 1024,
    },
  );
  const summary: CommitStatusSummary = {
    success: 0,
    failure: 0,
    pending: 0,
    cancelled: 0,
    total: 0,
  };
  if (result.status !== 0 || !result.stdout) return summary;
  try {
    const conclusions: string[] = JSON.parse(result.stdout.trim());
    for (const c of conclusions) {
      summary.total++;
      switch (c) {
        case "success":
          summary.success++;
          break;
        case "failure":
        case "timed_out":
        case "startup_failure":
          summary.failure++;
          break;
        case "cancelled":
        case "skipped":
        case "neutral":
          summary.cancelled++;
          break;
        default:
          summary.pending++;
          break;
      }
    }
  } catch {
    /* no checks */
  }
  return summary;
}

function formatStatusLabel(
  status: CommitStatusSummary,
  theme: ThemeAccessor,
): string {
  if (status.total === 0) return theme.fg("dim", "—");
  if (status.failure > 0) return theme.fg("error", `✗${status.failure}`);
  if (status.pending > 0) return theme.fg("warning", `○${status.pending}`);
  if (status.cancelled > 0 && status.cancelled === status.total)
    return theme.fg("dim", "⊘");
  return theme.fg("success", `✓${status.total}`);
}

// ============================================================================
// Helpers – checks & logs
// ============================================================================

function fetchCheckRuns(owner: string, repo: string, sha: string): CheckRun[] {
  const result = spawnSync(
    "gh",
    [
      "api",
      `repos/${owner}/${repo}/commits/${sha}/check-runs`,
      "--paginate",
      "--jq",
      `.check_runs[] | {id, name, status, conclusion, app: {slug: .app.slug, name: .app.name}, details_url, html_url, started_at, completed_at, output: {title: .output.title, summary: .output.summary, text: .output.text}}`,
    ],
    {
      encoding: "utf8",
      cwd: process.cwd(),
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  if (result.status !== 0 || !result.stdout) return [];
  const lines = result.stdout.trim().split("\n").filter(Boolean);
  const checks: CheckRun[] = [];
  for (const line of lines) {
    try {
      checks.push(JSON.parse(line));
    } catch {
      /* skip */
    }
  }
  return checks;
}

function findWorkflowRuns(sha: string, cwd: string): Map<number, WorkflowRun> {
  const result = spawnSync(
    "gh",
    [
      "run",
      "list",
      "--commit",
      sha,
      "--json",
      "databaseId,workflowName,jobs",
      "-L",
      "50",
    ],
    { encoding: "utf8", cwd, env: process.env, maxBuffer: 5 * 1024 * 1024 },
  );
  if (result.status !== 0 || !result.stdout) return new Map();
  const jobMap = new Map<number, WorkflowRun>();
  const repoInfo = getRepoInfo(cwd);
  const repoOwner = repoInfo?.owner ?? "?";
  const repoName = repoInfo?.repo ?? "?";
  try {
    const runs = JSON.parse(result.stdout);
    for (const run of runs) {
      for (const job of run.jobs || []) {
        jobMap.set(job.id, {
          databaseId: run.databaseId,
          workflowName: run.workflowName,
          jobName: job.name,
          jobId: job.id,
          runUrl: `https://github.com/${repoOwner}/${repoName}/actions/runs/${run.databaseId}/job/${job.id}`,
        });
      }
    }
  } catch {
    /* silently fail */
  }
  return jobMap;
}

function fetchJobLogs(owner: string, repo: string, jobId: number): string {
  const result = spawnSync(
    "gh",
    ["api", `repos/${owner}/${repo}/actions/jobs/${jobId}/logs`],
    {
      encoding: "utf8",
      cwd: process.cwd(),
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  if (result.status === 0 && result.stdout) {
    const lines = result.stdout.split("\n").filter((l) => {
      for (let i = 0; i < l.length; i++) {
        const code = l.charCodeAt(i);
        if (code < 32 && code !== 10 && code !== 13 && code !== 9) return false;
      }
      return true;
    });
    let combined = lines.join("\n");
    if (combined.length > 100_000)
      combined = combined.slice(0, 100_000) + "\n... [truncated to 100KB]";
    return combined;
  }
  return "";
}

function fetchAnnotations(
  owner: string,
  repo: string,
  checkRunId: number,
): string {
  const result = spawnSync(
    "gh",
    [
      "api",
      `repos/${owner}/${repo}/check-runs/${checkRunId}/annotations`,
      "--jq",
      '.[] | "\(.path):\(.start_line) \(.annotation_level): \(.message)"',
    ],
    {
      encoding: "utf8",
      cwd: process.cwd(),
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  if (result.status === 0 && result.stdout) return result.stdout.trim();
  return "";
}

function getCheckStatus(check: CheckRun): { icon: string; label: string } {
  const { status, conclusion } = check;
  if (!["completed"].includes(status))
    return { icon: "○", label: status === "queued" ? "queued" : "in progress" };
  switch (conclusion) {
    case "success":
      return { icon: "✓", label: "success" };
    case "failure":
      return { icon: "✗", label: "failure" };
    case "timed_out":
      return { icon: "✗", label: "timed out" };
    case "cancelled":
      return { icon: "⊘", label: "cancelled" };
    case "skipped":
      return { icon: "⊝", label: "skipped" };
    case "neutral":
      return { icon: "⊝", label: "neutral" };
    case "startup_failure":
      return { icon: "✗", label: "startup failure" };
    default:
      return { icon: "?", label: conclusion ?? "unknown" };
  }
}

// ============================================================================
// Branch Picker
// ============================================================================

async function pickBranch(
  ctx: ExtensionCommandContext,
  repoOwner: string,
  repoName: string,
  currentTarget?: string | null,
): Promise<string | null> {
  const branches = listBranches(repoOwner, repoName, ctx.cwd);
  if (branches.length === 0) {
    ctx.ui.notify("No branches found", "info");
    return null;
  }
  const items: SelectItem[] = branches.map((b) => {
    const isTarget = currentTarget && b.name === currentTarget;
    const isCurrent = b.current && !isTarget;
    let label = b.name,
      desc = "";
    if (isTarget) {
      label = `${b.name} (inspecting)`;
      desc = "Currently selected target";
    } else if (isCurrent) {
      label = `${b.name} (current)`;
      desc = "Your current working branch";
    }
    return { value: b.name, label, description: desc };
  });
  return ctx.ui.custom<string | null>(
    (tui, theme, _kb, done) => {
      const container = new Container();
      container.addChild(
        new Text(theme.fg("accent", theme.bold(" Select Branch to Inspect"))),
      );
      container.addChild(new Text(""));
      const sl = new SelectList(items, Math.min(items.length, 12), {
        selectedPrefix: (t: string) => theme.fg("accent", t),
        selectedText: (t: string) => theme.fg("accent", t),
        description: (t: string) => theme.fg("muted", t),
        scrollInfo: (t: string) => theme.fg("dim", t),
        noMatch: (t: string) => theme.fg("warning", t),
      });
      sl.onSelect = (item) => done(item.value);
      sl.onCancel = () => done(null);
      container.addChild(sl);
      container.addChild(new Text(""));
      container.addChild(
        new Text(theme.fg("dim", "↑↓ navigate · enter select · esc cancel")),
      );
      return {
        render: (w) => withBox((iw) => container.render(iw), w, theme),
        invalidate: () => container.invalidate(),
        handleInput: (data) => {
          sl.handleInput(data);
          tui.requestRender();
        },
      };
    },
    { overlay: true },
  );
}

// ============================================================================
// Screen 1: Commit List
// ============================================================================

async function showCommitList(
  ctx: ExtensionCommandContext,
  commits: CommitWithStatus[],
  pr: PRInfo | null,
  targetBranch: string | null,
): Promise<string | null> {
  return ctx.ui.custom<string | null>(
    (tui, theme, _kb, done) => {
      const container = new Container();

      const headerText = pr
        ? `PR #${pr.number}: ${pr.title}`
        : targetBranch || getCurrentBranch(ctx.cwd) || "HEAD";
      container.addChild(
        new Text(theme.fg("accent", theme.bold(` Commits on ${headerText}`))),
      );
      container.addChild(
        new Text(theme.fg("muted", `  ${commits.length} most recent`)),
      );
      container.addChild(new Text(""));

      const selectItems: SelectItem[] = commits.map((c) => {
        const statusStr = formatStatusLabel(c.status, theme);
        return {
          value: c.sha,
          label: `${statusStr} ${c.shortSha} ${c.message}`,
          description: `${c.status.total} checks · ${c.status.success}✓ ${c.status.failure}✗ ${c.status.pending}○`,
        };
      });

      const sl = new SelectList(selectItems, Math.min(selectItems.length, 18), {
        selectedPrefix: (t: string) => theme.fg("accent", t),
        selectedText: (t: string) => theme.fg("accent", t),
        description: (t: string) => theme.fg("dim", t),
        scrollInfo: (t: string) => theme.fg("dim", t),
        noMatch: (t: string) => theme.fg("warning", t),
      });
      sl.onSelect = (item) => done(item.value);
      sl.onCancel = () => done(null);
      container.addChild(sl);

      container.addChild(new Text(""));
      container.addChild(
        new Text(
          theme.fg(
            "dim",
            "↑↓ navigate · enter view checks · b switch branch · esc cancel",
          ),
        ),
      );

      return {
        render: (w) => withBox((iw) => container.render(iw), w, theme),
        invalidate: () => container.invalidate(),
        handleInput: (data) => {
          if (data === "b" || data === "B") {
            done(SWITCH_BRANCH);
            return;
          }
          sl.handleInput(data);
          tui.requestRender();
        },
      };
    },
    { overlay: true },
  );
}

// ============================================================================
// Screen 2: Check List for a selected commit
// ============================================================================

async function showCheckList(
  ctx: ExtensionCommandContext,
  commit: CommitWithStatus,
  checks: CheckRun[],
  pr: PRInfo | null,
): Promise<string | null> {
  const items: SelectItem[] = checks.map((check) => {
    const { icon, label } = getCheckStatus(check);
    return {
      value: String(check.id),
      label: `${icon} ${check.name}`,
      description: `${label} · ${check.app.name}`,
    };
  });

  return ctx.ui.custom<string | null>(
    (tui, theme, _kb, done) => {
      const container = new Container();

      const headerText = pr
        ? `PR #${pr.number}: ${pr.title}`
        : `${commit.shortSha}: ${commit.message.slice(0, 50)}${commit.message.length > 50 ? "..." : ""}`;
      container.addChild(
        new Text(theme.fg("accent", theme.bold(` Checks: ${headerText}`))),
      );

      const { status } = commit;
      const parts: string[] = [];
      if (status.failure > 0)
        parts.push(theme.fg("error", `${status.failure} failed`));
      if (status.success > 0)
        parts.push(theme.fg("success", `${status.success} passed`));
      if (status.pending > 0)
        parts.push(theme.fg("warning", `${status.pending} pending`));
      if (status.cancelled > 0)
        parts.push(theme.fg("dim", `${status.cancelled} cancelled/skipped`));
      if (parts.length > 0) {
        container.addChild(new Text(`  ${parts.join(" · ")}`));
        container.addChild(new Text(""));
      }

      const sl = new SelectList(items, Math.min(items.length, 14), {
        selectedPrefix: (t: string) => theme.fg("accent", t),
        selectedText: (t: string) => theme.fg("accent", t),
        description: (t: string) => theme.fg("muted", t),
        scrollInfo: (t: string) => theme.fg("dim", t),
        noMatch: (t: string) => theme.fg("warning", t),
      });
      sl.onSelect = (item) => done(item.value);
      sl.onCancel = () => done(null);
      container.addChild(sl);

      container.addChild(new Text(""));
      container.addChild(
        new Text(
          theme.fg(
            "dim",
            "↑↓ navigate · enter view logs · esc back to commit list",
          ),
        ),
      );

      return {
        render: (w) => withBox((iw) => container.render(iw), w, theme),
        invalidate: () => container.invalidate(),
        handleInput: (data) => {
          sl.handleInput(data);
          tui.requestRender();
        },
      };
    },
    { overlay: true },
  );
}

// ============================================================================
// Screen 3: Log Viewer (scrollable)
// ============================================================================

async function showLogViewer(
  ctx: ExtensionCommandContext,
  check: CheckRun,
  logs: string,
  logSource: string,
): Promise<"send_fix" | "back"> {
  const allLines = logs.split("\n");
  const totalLines = allLines.length;

  return ctx.ui.custom<"send_fix" | "back">(
    (tui, theme, _kb, done) => {
      let scrollY = 0;
      const { icon, label } = getCheckStatus(check);
      const checkLine = `${icon} ${check.name} — ${label}`;

      return {
        render: (w) =>
          withBox(
            (iw) => {
              // Reserve 3 lines for header, 2 for status+source footer = 5 overhead
              const headerHeight = 3;
              const footerHeight = 2;
              const maxVisible = Math.max(
                1,
                iw > 10 ? Math.floor(w * 0.6) - headerHeight - footerHeight : 5,
              );

              const result: string[] = [];
              // Header
              result.push(
                theme.fg("accent", theme.bold(` Logs: ${check.name}`)),
              );
              result.push(
                theme.fg(
                  "dim",
                  `  ${icon} ${label}${logSource ? ` · source: ${logSource}` : ""}`,
                ),
              );
              result.push("");

              // Clamp scroll
              if (scrollY > Math.max(0, totalLines - maxVisible))
                scrollY = Math.max(0, totalLines - maxVisible);
              if (scrollY < 0) scrollY = 0;

              if (totalLines === 0) {
                result.push(
                  theme.fg("warning", "  No logs available for this check."),
                );
              } else {
                const end = Math.min(scrollY + maxVisible, totalLines);
                for (let i = scrollY; i < end; i++) {
                  const line = allLines[i] || "";
                  result.push(line);
                }
              }

              // Footer
              result.push("");
              const scrollInfo =
                totalLines > 0
                  ? `${scrollY + 1}–${Math.min(scrollY + maxVisible, totalLines)} / ${totalLines}`
                  : "0 / 0";
              const scrollHint = totalLines > maxVisible ? ` · ↑↓ scroll` : "";
              result.push(
                theme.fg(
                  "dim",
                  `${scrollInfo}${scrollHint} · f send fix · esc back`,
                ),
              );
              return result;
            },
            w,
            theme,
          ),
        invalidate: () => {
          /* no children to invalidate */
        },
        handleInput: (data) => {
          if (data === "f" || data === "F") {
            done("send_fix");
            return;
          }
          if (data === "up" || data === "UP") {
            scrollY = Math.max(0, scrollY - 1);
            tui.requestRender();
            return;
          }
          if (data === "down" || data === "DOWN") {
            scrollY++;
            tui.requestRender();
            return;
          }
          if (data === "esc" || data === "ESCAPE") {
            done("back");
            return;
          }
          // Page up/down
          if (data === "page_up" || data === "PAGE_UP") {
            scrollY = Math.max(0, scrollY - 20);
            tui.requestRender();
            return;
          }
          if (data === "page_down" || data === "PAGE_DOWN") {
            scrollY += 20;
            tui.requestRender();
            return;
          }
          // Home/End
          if (data === "home" || data === "HOME") {
            scrollY = 0;
            tui.requestRender();
            return;
          }
          if (data === "end" || data === "END") {
            scrollY = Math.max(0, totalLines - 1);
            tui.requestRender();
            return;
          }
        },
      };
    },
    { overlay: true },
  );
}

// ============================================================================
// Fix Prompt Builder
// ============================================================================

function buildFixMessage(
  check: CheckRun,
  logs: string,
  logSource: string,
  commit: CommitInfo,
  pr: PRInfo | null,
): string {
  const { label: checkResult } = getCheckStatus(check);
  const prContext = pr
    ? `PR: #${pr.number} - ${pr.title} (branch: ${pr.branch})`
    : `Commit: ${commit.message} (${commit.shortSha})`;

  if (logs) {
    return `🔧 Fix Failing CI Check

**Failed Check:** ${check.name}
**Status:** ${checkResult}
**App:** ${check.app.name}
${prContext}
${check.html_url ? `**URL:** ${check.html_url}` : ""}
${logSource ? `**Log source:** ${logSource}` : ""}

Here are the full logs from the failed CI check:

\`\`\`
${logs}
\`\`\`

Please analyze the CI failure above and fix the root cause. Follow these steps:

1. **Diagnose** - Look at the logs carefully. Is this a:
   - Compilation/build error? → fix the code
   - Test failure? → fix the test or the implementation
   - Linting/formatting issue? → fix the offending code
   - Configuration issue? → fix workflow files, env vars, or config
   - Dependency issue? → update lockfiles, package.json, etc.
   - Infrastructure issue? → check GitHub Actions runner setup
   - Flaky test? → consider retry logic or test isolation

2. **Verify** - Check if you can reproduce locally. Read relevant files first.

3. **Fix** - Make the minimal change needed to resolve the issue. For each change:
   - Explain why the fix works
   - Show what changed
   - Run relevant commands to verify

4. **After fixing** - Summarize what was wrong and how it was fixed.

If the failure is transient or environmental (network issues, runner problems), note that and suggest re-running the workflow.`;
  }

  return `🔧 Fix Failing CI Check

**Failed Check:** ${check.name}
**Status:** ${checkResult}
**App:** ${check.app.name}
${prContext}
${check.html_url ? `**URL:** ${check.html_url}` : ""}

**Note:** No detailed logs could be fetched. Please investigate by:
1. Opening the check URL above (if available) to view the details
2. Running relevant commands locally to reproduce
3. Reading any available output, summary, or annotations

Please diagnose and fix the CI failure. Look for:
- Recent changes that might have caused the failure
- Build errors, test failures, or linting issues
- Configuration or environment problems`;
}

// ============================================================================
// Main Command – three-screen flow
// ============================================================================

async function ciCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  initialBranch?: string,
): Promise<void> {
  // Prerequisites
  const ghCheck = spawnSync("which", ["gh"], { encoding: "utf8" });
  if (ghCheck.status !== 0) {
    ctx.ui.notify(
      "gh CLI is not installed. Install with: brew install gh",
      "error",
    );
    return;
  }
  const gitCheck = spawnSync("which", ["git"], { encoding: "utf8" });
  if (gitCheck.status !== 0) {
    ctx.ui.notify("git is not installed", "error");
    return;
  }

  const repo = getRepoInfo(ctx.cwd);
  if (!repo) {
    ctx.ui.notify("No GitHub remote found", "error");
    return;
  }

  let targetBranch: string | null = initialBranch ?? null;
  let firstRun = true;

  while (true) {
    // ---- Resolve branch and fetch PR info ----
    let pr: PRInfo | null;
    if (targetBranch && targetBranch !== "HEAD") {
      if (firstRun)
        ctx.ui.notify(
          `Fetching commits for branch "${targetBranch}"...`,
          "info",
        );
      pr = getPRForBranch(repo.owner, repo.repo, targetBranch);
    } else {
      if (firstRun) ctx.ui.notify("Fetching commits...", "info");
      const currentBranch = getCurrentBranch(ctx.cwd);
      if (!currentBranch && !targetBranch) {
        ctx.ui.notify("Not on a branch and no branch specified", "error");
        return;
      }
      targetBranch = currentBranch ?? "HEAD";
      pr = getCurrentPR(ctx.cwd);
    }
    firstRun = false;

    // ---- Fetch commits ----
    const rawCommits =
      targetBranch === "HEAD"
        ? fetchLocalCommits(getCurrentBranch(ctx.cwd) ?? "HEAD", ctx.cwd)
        : fetchRemoteCommits(repo.owner, repo.repo, targetBranch);
    if (rawCommits.length === 0) {
      ctx.ui.notify("No commits found", "info");
      return;
    }

    // ---- Fetch CI status for each commit ----
    ctx.ui.notify(
      `Fetching CI status for ${rawCommits.length} commits...`,
      "info",
    );
    const commitsWithStatus: CommitWithStatus[] = [];
    for (const c of rawCommits) {
      commitsWithStatus.push({
        ...c,
        status: fetchCommitCISummary(repo.owner, repo.repo, c.sha),
      });
    }

    // ---- Screen 1: Commit list ----
    const selectedSha = await showCommitList(
      ctx,
      commitsWithStatus,
      pr,
      targetBranch,
    );
    if (selectedSha === SWITCH_BRANCH) {
      const picked = await pickBranch(ctx, repo.owner, repo.repo, targetBranch);
      if (!picked) continue;
      targetBranch = picked;
      firstRun = true;
      continue;
    }
    if (!selectedSha) {
      ctx.ui.notify("No commit selected", "info");
      return;
    }

    const selectedCommit = commitsWithStatus.find((c) => c.sha === selectedSha);
    if (!selectedCommit) {
      ctx.ui.notify("Selected commit not found", "error");
      return;
    }

    // ---- Fetch checks for selected commit ----
    const checks = fetchCheckRuns(repo.owner, repo.repo, selectedCommit.sha);
    if (checks.length === 0) {
      ctx.ui.notify("No CI checks for this commit", "info");
      continue;
    }

    // ---- Screen 2: Check list (loops, esc goes back to commit list) ----
    while (true) {
      const selectedCheckId = await showCheckList(
        ctx,
        selectedCommit,
        checks,
        pr,
      );
      if (!selectedCheckId) break; // esc → back to commit list

      const selectedCheck = checks.find(
        (c) => String(c.id) === selectedCheckId,
      );
      if (!selectedCheck) {
        ctx.ui.notify("Selected check not found", "error");
        break;
      }

      // ---- Fetch logs ----
      ctx.ui.notify(`Fetching logs for: ${selectedCheck.name}...`, "info");

      const workflowMap = findWorkflowRuns(selectedCommit.sha, ctx.cwd);
      let logs = "",
        logSource = "";

      const wfRun = workflowMap.get(selectedCheck.id);
      if (wfRun) {
        logs = fetchJobLogs(repo.owner, repo.repo, wfRun.jobId);
        if (logs) logSource = "GitHub Actions job logs";
      }
      if (!logs && selectedCheck.output?.text) {
        logs = selectedCheck.output.text;
        logSource = "check run output";
      }
      if (!logs) {
        const ann = fetchAnnotations(repo.owner, repo.repo, selectedCheck.id);
        if (ann) {
          logs = ann;
          logSource = "check annotations";
        }
      }
      if (!logs && selectedCheck.details_url) {
        const runIdMatch =
          selectedCheck.details_url.match(/actions\/runs\/(\d+)/);
        if (runIdMatch) {
          const r = spawnSync(
            "gh",
            [
              "run",
              "view",
              runIdMatch[1],
              "--log",
              "--job",
              String(selectedCheck.id),
            ],
            {
              encoding: "utf8",
              cwd: ctx.cwd,
              env: process.env,
              maxBuffer: 10 * 1024 * 1024,
            },
          );
          if (r.status === 0 && r.stdout) {
            logs = r.stdout;
            if (logs.length > 100_000)
              logs = logs.slice(0, 100_000) + "\n... [truncated to 100KB]";
            logSource = "GitHub Actions logs";
          }
        }
      }

      if (!logs) logs = "";

      // ---- Screen 3: Log Viewer ----
      const logAction = await showLogViewer(
        ctx,
        selectedCheck,
        logs,
        logSource,
      );

      if (logAction === "back") continue; // esc → back to check list
      if (logAction === "send_fix") {
        const fixMessage = buildFixMessage(
          selectedCheck,
          logs,
          logSource,
          selectedCommit,
          pr,
        );
        ctx.ui.notify(`Sending fix prompt for: ${selectedCheck.name}`, "info");
        pi.sendUserMessage(fixMessage);
        return;
      }
    }
  }
}

// ============================================================================
// Autocomplete for branch names
// ============================================================================

function getBranchAutocomplete(prefix: string): AutocompleteItem[] | null {
  const repo = getRepoInfo(process.cwd());
  if (!repo) return null;
  if (!prefix) {
    const current = getCurrentBranch(process.cwd());
    if (current) return [{ value: current, label: `${current} (current)` }];
    return null;
  }
  const branches = listBranches(repo.owner, repo.repo, process.cwd());
  const filtered = branches
    .filter((b) => b.name.toLowerCase().startsWith(prefix.toLowerCase()))
    .map((b) => ({
      value: b.name,
      label: b.current ? `${b.name} (current)` : b.name,
    }));
  return filtered.length > 0 ? filtered : null;
}

// ============================================================================
// Extension Entry Point
// ============================================================================

export default function (pi: ExtensionAPI) {
  pi.registerCommand("ci", {
    description:
      "Browse commits with CI status, view check logs, and send a fix prompt to the LLM.",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      return getBranchAutocomplete(prefix);
    },
    handler: async (args, ctx) => {
      try {
        const branch = args.trim() || undefined;
        await ciCommand(pi, ctx, branch);
      } catch (err) {
        console.error("[github-ci-status] Error:", err);
        ctx.ui.notify(
          `Error: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("GitHub CI Status extension ready: /ci", "info");
  });
}
