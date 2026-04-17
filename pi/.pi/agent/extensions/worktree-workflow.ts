/**
 * Worktree Workflow Extension
 *
 * Enforces worktree-based development across multiple repos with session management.
 *
 * Commands:
 *   /sessions              - List all sessions across all worktrees
 *   /feature <name>        - Create new worktree + switch session to it
 *   /cleanup               - List and optionally delete merged worktrees
 *
 * Auto-behavior:
 *   - Blocks file modifications in master repo (forces worktree creation)
 *   - Sessions named after worktree branch
 *   - Worktrees stored at ~/Worktrees/<repo>/<branch>
 */

import type { ExtensionAPI, SessionManager } from "@mariozechner/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve, basename, dirname, join } from "node:path";
import { homedir } from "node:os";

interface WorktreeInfo {
  path: string;
  branch: string;
  isMaster: boolean;
}

interface RepoSession {
  repoName: string;
  worktreePath: string;
  branch: string;
  sessionFile: string | null;
}

function runGit(cwd: string, args: string[]): { stdout: string; stderr: string; code: number } {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  return {
    stdout: result.stdout?.trim() || "",
    stderr: result.stderr?.trim() || "",
    code: result.status ?? -1,
  };
}

function getRepoRoot(cwd: string): string | null {
  const result = runGit(cwd, ["rev-parse", "--show-toplevel"]);
  return result.code === 0 ? result.stdout : null;
}

function getCurrentBranch(cwd: string): string | null {
  const result = runGit(cwd, ["branch", "--show-current"]);
  return result.code === 0 ? result.stdout : null;
}

function isInWorktree(cwd: string): boolean {
  const result = runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (result.code !== 0) return false;

  // Check if this is a linked worktree (not the main one)
  const worktreeResult = runGit(cwd, ["rev-parse", "--git-common-dir"]);
  if (worktreeResult.code !== 0) return false;

  // If git-common-dir is different from .git, we're in a linked worktree
  const gitDir = runGit(cwd, ["rev-parse", "--git-dir"]);
  return gitDir.code === 0 && gitDir.stdout !== worktreeResult.stdout;
}

function listWorktrees(cwd: string): WorktreeInfo[] {
  const result = runGit(cwd, ["worktree", "list", "--porcelain"]);
  if (result.code !== 0) return [];

  const worktrees: WorktreeInfo[] = [];
  const lines = result.stdout.split("\n");
  let current: Partial<WorktreeInfo> = {};

  for (const line of lines) {
    if (line.startsWith("worktree ")) {
      if (current.path) {
        worktrees.push({
          path: current.path,
          branch: current.branch || "",
          isMaster: !current.branch || line.includes("master") || line.includes("main"),
        });
      }
      current = { path: line.slice(9) };
    } else if (line.startsWith("branch ")) {
      current.branch = basename(line.slice(7));
    } else if (line === "bare" || line === "detached") {
      current.isMaster = true;
    }
  }

  // Push last one
  if (current.path) {
    worktrees.push({
      path: current.path,
      branch: current.branch || "",
      isMaster: !current.branch,
    });
  }

  return worktrees;
}

function getWorktreesDir(): string {
  return resolve(homedir(), "Worktrees");
}

function getRepoName(repoRoot: string): string {
  return basename(repoRoot);
}

function findOrCreateSessionForWorktree(
  repoName: string,
  branch: string,
  worktreePath: string,
  sessionManager: SessionManager,
): string | null {
  // Look for existing session with this worktree
  const entries = sessionManager.getEntries();
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === "worktree-info") {
      const info = entry.data as { repo: string; branch: string; path: string };
      if (info.repo === repoName && info.branch === branch) {
        // Found existing session
        return sessionManager.getSessionFile();
      }
    }
  }
  return null;
}

export default function (pi: ExtensionAPI) {
  // Block edits in master repo
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "edit" || event.toolName === "write") {
      // Check if we're in a worktree
      if (!isInWorktree(ctx.cwd)) {
        return {
          block: true,
          reason:
            "File modifications blocked: You are in the master repo. " +
            "All work must be done in worktrees. " +
            "Run `/feature <branch-name>` to create a worktree first.",
        };
      }
    }
  });

  // Track worktree info in session
  pi.on("session_start", async (event, ctx) => {
    const repoRoot = getRepoRoot(ctx.cwd);
    if (!repoRoot) return;

    const branch = getCurrentBranch(ctx.cwd);
    if (!branch) return;

    // Store worktree info in session
    pi.appendEntry("worktree-info", {
      repo: getRepoName(repoRoot),
      branch,
      path: ctx.cwd,
      isWorktree: isInWorktree(ctx.cwd),
    });

    // Update session name if in worktree
    if (isInWorktree(ctx.cwd)) {
      const repo = getRepoName(repoRoot);
      pi.setSessionName(`${repo}/${branch}`);
    }
  });

  // /feature command - Create new worktree
  pi.registerCommand("feature", {
    description: "Create a new worktree for a feature branch",
    handler: async (args, ctx) => {
      const branchName = args.trim();
      if (!branchName) {
        ctx.ui.notify("Usage: /feature <branch-name>", "error");
        return;
      }

      const repoRoot = getRepoRoot(ctx.cwd);
      if (!repoRoot) {
        ctx.ui.notify("Not in a git repository", "error");
        return;
      }

      const repoName = getRepoName(repoRoot);
      const worktreesDir = join(getWorktreesDir(), repoName);
      const worktreePath = join(worktreesDir, branchName);

      // Create worktrees directory if needed
      if (!existsSync(worktreesDir)) {
        mkdirSync(worktreesDir, { recursive: true });
      }

      // Check if worktree already exists
      if (existsSync(worktreePath)) {
        ctx.ui.notify(`Worktree ${branchName} already exists`, "error");
        return;
      }

      ctx.ui.notify(`Creating worktree ${branchName}...`, "info");

      // Create the worktree
      const result = runGit(repoRoot, ["worktree", "add", "-b", branchName, worktreePath]);
      if (result.code !== 0) {
        ctx.ui.notify(`Failed to create worktree: ${result.stderr}`, "error");
        return;
      }

      // Store worktree info
      pi.appendEntry("worktree-info", {
        repo: repoName,
        branch: branchName,
        path: worktreePath,
        isWorktree: true,
      });

      // Set session name
      pi.setSessionName(`${repoName}/${branchName}`);

      ctx.ui.notify(`Created worktree at ${worktreePath}`, "success");
      ctx.ui.notify("Session now active in worktree", "info");

      // Note: pi stays in current directory, user can cd if needed
      // The session is now "claimed" by this worktree
    },
  });

  // /sessions command - List and switch between worktrees
  pi.registerCommand("sessions", {
    description: "List all worktree sessions across all repos",
    handler: async (_args, ctx) => {
      // Get all sessions from session manager
      const sessions: RepoSession[] = [];
      const currentFile = ctx.sessionManager.getSessionFile();

      // Scan for sessions in worktrees directory
      const worktreesRoot = getWorktreesDir();
      if (existsSync(worktreesRoot)) {
        // Use bash to find all worktree paths
        const result = spawnSync(
          "find",
          [worktreesRoot, "-type", "d", "-name", "*.jsonl"],
          { encoding: "utf-8" },
        );

        // Also scan for active worktrees and their sessions
        const entries = ctx.sessionManager.getEntries();
        const seenWorktrees = new Set<string>();

        for (const entry of entries) {
          if (entry.type === "custom" && entry.customType === "worktree-info") {
            const info = entry.data as { repo: string; branch: string; path: string };
            const key = `${info.repo}/${info.branch}`;
            if (!seenWorktrees.has(key)) {
              seenWorktrees.add(key);
              sessions.push({
                repoName: info.repo,
                worktreePath: info.path,
                branch: info.branch,
                sessionFile: currentFile && ctx.sessionManager.getSessionFile() === currentFile ? currentFile : null,
              });
            }
          }
        }
      }

      if (sessions.length === 0) {
        ctx.ui.notify("No worktree sessions found. Create one with /feature <name>", "info");
        return;
      }

      // Build selection items
      const items = sessions.map((s) => ({
        value: s.worktreePath,
        label: `${s.repoName}/${s.branch}`,
        description: s.worktreePath,
      }));

      const choice = await ctx.ui.select("Select worktree session:", items);
      if (!choice) return;

      // Find the selected session
      const selected = sessions.find((s) => s.worktreePath === choice);
      if (!selected) return;

      // Check if there's a session file for this worktree
      const targetSession = spawnSync(
        "find",
        [resolve(homedir(), ".pi", "agent", "sessions"), "-name", "*.jsonl"],
        { encoding: "utf-8" },
      );

      // For now, we create a new session entry and switch to it
      // In a full implementation, we'd look up the existing session file
      ctx.ui.notify(`Switching to ${selected.repoName}/${selected.branch}...`, "info");

      // Use navigateTree or newSession to switch
      // For worktree switching, we'll use fork to create new session from current point
      const result = await ctx.fork(ctx.sessionManager.getLeafId() || "");
      if (result.cancelled) {
        ctx.ui.notify("Session switch cancelled", "info");
        return;
      }

      // Update worktree info for new session
      pi.appendEntry("worktree-info", {
        repo: selected.repoName,
        branch: selected.branch,
        path: selected.worktreePath,
        isWorktree: true,
      });

      pi.setSessionName(`${selected.repoName}/${selected.branch}`);
      ctx.ui.notify(`Now in session: ${selected.repoName}/${selected.branch}`, "success");
      ctx.ui.notify(`Worktree: ${selected.worktreePath}`, "info");
    },
  });

  // /cleanup command - Remove merged worktrees
  pi.registerCommand("cleanup", {
    description: "List and remove merged worktrees",
    handler: async (_args, ctx) => {
      const repoRoot = getRepoRoot(ctx.cwd);
      if (!repoRoot) {
        ctx.ui.notify("Not in a git repository", "error");
        return;
      }

      // Get all worktrees
      const worktrees = listWorktrees(repoRoot);
      const mergedBranches: string[] = [];

      // Check which branches are merged
      for (const wt of worktrees) {
        if (wt.isMaster || !wt.branch) continue;

        const result = runGit(repoRoot, ["branch", "--merged", "HEAD", "--list", wt.branch]);
        if (result.stdout.includes(wt.branch)) {
          mergedBranches.push(wt.branch);
        }
      }

      if (mergedBranches.length === 0) {
        ctx.ui.notify("No merged worktrees to clean up", "info");
        return;
      }

      // Show merged branches
      const items = mergedBranches.map((b) => ({
        value: b,
        label: b,
        description: "Branch is merged, safe to delete",
      }));

      const toDelete = await ctx.ui.select(
        "Select worktrees to remove (merged branches):",
        items,
      );

      if (!toDelete) return;

      // Remove worktree
      const worktreesDir = join(getWorktreesDir(), getRepoName(repoRoot));
      const worktreePath = join(worktreesDir, toDelete);

      ctx.ui.notify(`Removing worktree ${toDelete}...`, "info");

      const result = runGit(repoRoot, ["worktree", "remove", worktreePath]);
      if (result.code !== 0) {
        ctx.ui.notify(`Failed to remove worktree: ${result.stderr}`, "error");
        return;
      }

      ctx.ui.notify(`Removed worktree ${toDelete}`, "success");

      // Also offer to delete branch
      const deleteBranch = await ctx.ui.confirm(
        "Delete branch?",
        `Also delete branch ${toDelete}?`,
      );

      if (deleteBranch) {
        const branchResult = runGit(repoRoot, ["branch", "-d", toDelete]);
        if (branchResult.code === 0) {
          ctx.ui.notify(`Deleted branch ${toDelete}`, "success");
        } else {
          ctx.ui.notify(`Failed to delete branch: ${branchResult.stderr}`, "error");
        }
      }
    },
  });

  // Notify on load
  pi.on("session_start", async (_event, ctx) => {
    const inWorktree = isInWorktree(ctx.cwd);
    if (inWorktree) {
      ctx.ui.notify("Worktree Workflow: active in worktree", "info");
    } else {
      ctx.ui.notify("Worktree Workflow: master repo (read-only). Use /feature to create worktree", "info");
    }
  });
}
