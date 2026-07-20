/**
 * PR Comments Extension
 *
 * /comments — shows a modal with all unresolved PR review comments for
 * the current branch. Selecting a comment loads it into the editor.
 *
 * Dependencies: gh CLI (github.com/cli/cli)
 */

import { execSync, spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
  Container,
  type SelectItem,
  SelectList,
  Text,
} from "@earendil-works/pi-tui";

// ── Types ───────────────────────────────────────────────────────────────────

interface ReviewThread {
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  startLine: number | null;
  comments: Array<{
    body: string;
    author: { login: string };
    createdAt: string;
  }>;
}

interface GraphQLThreadNode {
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  comments: {
    nodes: Array<{
      body: string;
      author: { login: string } | null;
      createdAt: string;
    }>;
  };
}

interface GraphQLResponse {
  data?: {
    repository?: {
      pullRequest?: {
        reviewThreads?: {
          nodes?: GraphQLThreadNode[];
        };
      };
    };
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Get the current git branch name.
 */
function getGitBranch(cwd: string): string {
  const result = execSync("git rev-parse --abbrev-ref HEAD", {
    cwd,
    encoding: "utf-8",
  });
  return result.trim();
}

/**
 * Extract owner/repo from the origin remote URL.
 */
function getRepoInfo(cwd: string): { owner: string; repo: string } | null {
  try {
    const url = execSync("git remote get-url origin", {
      cwd,
      encoding: "utf-8",
    }).trim();
    const match = url.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (match) {
      return { owner: match[1], repo: match[2] };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Find the PR number for a branch, or null if none.
 */
function findPrNumber(branch: string, cwd: string): number | null {
  try {
    const result = execSync(
      `gh pr list --head "${branch}" --json number --jq '.[0].number'`,
      { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
    return result ? parseInt(result, 10) : null;
  } catch {
    return null;
  }
}

/**
 * Fetch unresolved, non-outdated review threads for a PR.
 */
function fetchUnresolvedThreads(
  owner: string,
  repo: string,
  pr: number,
): ReviewThread[] {
  const query = `
query($owner:String!, $repo:String!, $pr:Int!) {
  repository(owner:$owner, name:$repo) {
    pullRequest(number:$pr) {
      reviewThreads(first:50) {
        nodes {
          isResolved
          isOutdated
          path
          line
          startLine
          comments(first:10) {
            nodes {
              body
              author { login }
              createdAt
            }
          }
        }
      }
    }
  }
}`;

  const result = spawnSync(
    "gh",
    [
      "api",
      "graphql",
      "-F",
      `owner=${owner}`,
      "-F",
      `repo=${repo}`,
      "-F",
      `pr=${pr}`,
      "-f",
      `query=${query}`,
    ],
    { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
  );

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `gh api graphql failed (exit ${result.status}): ${result.stderr}`,
    );
  }

  const json = JSON.parse(result.stdout) as GraphQLResponse;
  const nodes = json?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];

  return nodes
    .filter((n) => !n.isResolved && !n.isOutdated)
    .map((n) => ({
      isResolved: n.isResolved,
      isOutdated: n.isOutdated,
      path: n.path,
      line: n.line ?? null,
      startLine: (n as any).startLine ?? null,
      comments: (n.comments?.nodes ?? []).map((c) => ({
        body: c.body,
        author: { login: c.author?.login ?? "unknown" },
        createdAt: c.createdAt,
      })),
    }));
}

/**
 * Truncate a string to maxLen chars, adding ellipsis if cut.
 */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + "…";
}

/**
 * Format an ISO date string to a short human-readable form.
 */
function formatDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerCommand("comments", {
    description: "Show unresolved PR review comments for the current branch",
    handler: async (_args, ctx) => {
      // ── Guard: interactive only ──
      if (!ctx.hasUI) {
        ctx.ui.notify("/comments requires interactive mode", "error");
        return;
      }

      // ── Guard: gh CLI ──
      try {
        execSync("which gh", { encoding: "utf-8" });
      } catch {
        ctx.ui.notify(
          "GitHub CLI (gh) is required. Install: brew install gh",
          "error",
        );
        return;
      }

      // ── Guard: git repo ──
      let branch: string;
      try {
        branch = getGitBranch(ctx.cwd);
      } catch {
        ctx.ui.notify("Not in a git repository", "error");
        return;
      }

      // ── Guard: GitHub remote ──
      const repoInfo = getRepoInfo(ctx.cwd);
      if (!repoInfo) {
        ctx.ui.notify(
          "Could not determine GitHub owner/repo from origin remote",
          "error",
        );
        return;
      }

      // ── Find the PR ──
      const prNumber = findPrNumber(branch, ctx.cwd);
      if (!prNumber) {
        ctx.ui.notify(`No open PR found for branch "${branch}"`, "info");
        return;
      }

      // ── Fetch unresolved comments ──
      let threads: ReviewThread[];
      try {
        threads = fetchUnresolvedThreads(
          repoInfo.owner,
          repoInfo.repo,
          prNumber,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Failed to fetch review threads: ${msg}`, "error");
        return;
      }

      if (threads.length === 0) {
        ctx.ui.notify(
          `PR #${prNumber} has no unresolved review comments`,
          "info",
        );
        return;
      }

      // ── Build selection items ──
      const items: SelectItem[] = threads.map((thread) => {
        const firstComment = thread.comments[0];
        const body = firstComment?.body ?? "(no text)";
        const author = firstComment?.author?.login ?? "unknown";
        const when = firstComment?.createdAt
          ? formatDate(firstComment.createdAt)
          : "";
        const location = thread.line
          ? `${thread.path}:L${thread.line}`
          : thread.path;

        // Format a context header for the editor
        const lineRange =
          thread.line != null
            ? thread.startLine != null && thread.startLine !== thread.line
              ? `L${thread.startLine}-L${thread.line}`
              : `L${thread.line}`
            : "file-level";
        const contextHeader = `[PR #${prNumber} review comment — ${thread.path}:${lineRange} by @${author}]`;
        const formattedBody = `${contextHeader}\n${body}`;

        return {
          value: formattedBody,
          label: truncate(body.replace(/\n/g, " "), 72),
          description: `${location} · @${author} · ${when}`,
        };
      });

      // ── Show selection modal ──
      const selected = await ctx.ui.custom<string | null>(
        (tui, theme, _kb, done) => {
          const container = new Container();

          // Top border
          container.addChild(
            new DynamicBorder((s: string) => theme.fg("accent", s)),
          );

          // Header
          container.addChild(
            new Text(
              theme.fg(
                "accent",
                theme.bold(
                  `Unresolved Comments — ${repoInfo.owner}/${repoInfo.repo}#${prNumber}`,
                ),
              ),
              1,
              0,
            ),
          );

          const selectList = new SelectList(items, Math.min(items.length, 12), {
            selectedPrefix: (t: string) => theme.fg("accent", t),
            selectedText: (t: string) => theme.fg("accent", t),
            description: (t: string) => theme.fg("muted", t),
            scrollInfo: (t: string) => theme.fg("dim", t),
            noMatch: (t: string) => theme.fg("warning", t),
          });

          selectList.onSelect = (item) => done(item.value);
          selectList.onCancel = () => done(null);

          container.addChild(selectList);

          // Hint
          container.addChild(
            new Text(
              theme.fg(
                "dim",
                "↑↓ navigate · enter load into editor · esc cancel",
              ),
              1,
              0,
            ),
          );

          // Bottom border
          container.addChild(
            new DynamicBorder((s: string) => theme.fg("accent", s)),
          );

          return {
            render: (w: number) => container.render(w),
            invalidate: () => container.invalidate(),
            handleInput: (data: string) => {
              selectList.handleInput(data);
              tui.requestRender();
            },
          };
        },
      );

      // ── Handle selection ──
      if (selected === null) {
        // User cancelled
        return;
      }

      ctx.ui.setEditorText(selected);
      ctx.ui.notify(
        "Comment loaded into editor. Edit and submit when ready.",
        "info",
      );
    },
  });
}
