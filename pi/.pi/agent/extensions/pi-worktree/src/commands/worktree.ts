import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { execCommand, getSessionName } from "../utils.ts";
import { getCurrentWorktreePath, createBranch, getCurrentCommit, createWorktree as createGitWorktree, getMainBranch } from "../git.ts";
import { attachToSession } from "../tmux.ts";
import { selectRepo } from "../ui/repo-picker.ts";
import { selectWorktree } from "../ui/worktree-picker.ts";
import { createWorktreeDialog } from "../ui/dialogs.ts";
import { getGlobalClient } from "../daemon/client.ts";
import { homedir } from "node:os";
import { join } from "node:path";

const client = getGlobalClient();

// Main /wt command handler
export async function worktreeCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<void> {
  // Check tmux is available
  const tmuxCheck = await execCommand(pi, "which", ["tmux"]);
  if (tmuxCheck.code !== 0) {
    ctx.ui.notify("tmux is not installed", "error");
    return;
  }

  ctx.ui.notify("Scanning ~/Code for git repositories...", "info");
  
  // Use daemon client for fast cached results
  const repos = await client.getRepos();

  if (repos.length === 0) {
    ctx.ui.notify("No git repositories found in ~/Code", "warning");
    return;
  }

  const selectedRepo = await selectRepo(pi, ctx, repos);
  if (!selectedRepo) return;

  const worktreeResult = await selectWorktree(pi, ctx, selectedRepo);
  if (!worktreeResult) return;

  let worktreePath: string;
  let branch: string;

  if (worktreeResult.isNew) {
    // Create new worktree
    const branchName = await createWorktreeDialog(ctx, selectedRepo);
    if (!branchName) return;

    const newWorktree = await createNewWorktree(pi, ctx, selectedRepo.path, branchName);
    if (!newWorktree) return;

    worktreePath = newWorktree.path;
    branch = newWorktree.branch;
    
    // Refresh daemon's repo cache since we created a new worktree
    await client.refreshRepos();
  } else {
    worktreePath = worktreeResult.worktree.path;
    branch = worktreeResult.worktree.branch;
  }

  // If session was waiting, mark as idle BEFORE switching (so we write to correct session)
  const status = await client.getStatus(worktreePath);
  if (status?.status === "waiting") {
    const { setSessionOption } = await import("../tmux.ts");
    const { getCurrentSession } = await import("../tmux.ts");
    const sessionName = await getCurrentSession(pi);
    if (sessionName) {
      await setSessionOption(pi, sessionName, "@pi-status", "idle");
    }
  }

  // Attach to session
  const sessionName = getSessionName(worktreePath);
  await attachToSession(pi, sessionName, worktreePath, "pi");

  ctx.ui.notify(`Switched to ${branch}`, "info");
}

// Helper to create a new worktree with branch
async function createNewWorktree(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  repoPath: string,
  branchName: string,
): Promise<{ path: string; branch: string } | null> {
  const safeBranch = branchName.replace(/\//g, "_");
  const repoName = repoPath.split("/").pop() || "repo";
  const worktreePath = join(homedir(), ".worktrees", repoName, safeBranch);

  // Check if branch exists, create if not
  const { branchExists } = await import("../git.ts");
  const exists = await branchExists(pi, repoPath, branchName);
  if (!exists) {
    const currentCommit = await getCurrentCommit(pi, repoPath);
    if (!currentCommit) {
      ctx.ui.notify("Failed to get current commit. Is this an empty repo?", "error");
      return null;
    }

    const created = await createBranch(pi, repoPath, branchName, currentCommit);
    if (!created) {
      ctx.ui.notify(`Failed to create branch: ${branchName}`, "error");
      return null;
    }
  }

  // Create parent directory
  const parentDir = join(homedir(), ".worktrees", repoName);
  await execCommand(pi, "mkdir", ["-p", parentDir]);

  // Create worktree
  const success = await createGitWorktree(pi, repoPath, worktreePath, branchName);
  if (!success) {
    ctx.ui.notify("Failed to create worktree", "error");
    return null;
  }

  return { path: worktreePath, branch: branchName };
}
