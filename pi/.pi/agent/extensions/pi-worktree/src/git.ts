import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { RepoInfo, WorktreeInfo } from "./types.ts";
import { execCommand } from "./utils.ts";
import { homedir } from "node:os";
import { join, basename } from "node:path";

// Check if directory is a git repo with worktrees
export async function isGitRepo(
  pi: ExtensionAPI,
  dir: string,
): Promise<boolean> {
  const result = await execCommand(
    pi,
    "git",
    ["rev-parse", "--is-bare-repository"],
    dir,
  );
  if (result.code === 0 && result.stdout.trim() === "true") return true;
  const worktreeResult = await execCommand(
    pi,
    "git",
    ["rev-parse", "--git-dir"],
    dir,
  );
  return worktreeResult.code === 0;
}

// Get worktrees for a repo
export async function getWorktrees(
  pi: ExtensionAPI,
  repoPath: string,
): Promise<WorktreeInfo[]> {
  const result = await execCommand(
    pi,
    "git",
    ["worktree", "list", "--porcelain"],
    repoPath,
  );
  if (result.code !== 0) return [];

  const worktrees: WorktreeInfo[] = [];
  const lines = result.stdout.split("\n");
  let current: Partial<WorktreeInfo> = {};

  for (const line of lines) {
    if (line.startsWith("worktree ")) {
      if (current.path) worktrees.push(current as WorktreeInfo);
      current = { path: line.slice(9).trim() };
    } else if (line.startsWith("branch ")) {
      current.branch = line
        .slice(7)
        .trim()
        .replace(/^refs\/heads\//, "");
    } else if (line === "bare") {
      current.isBare = true;
    } else if (line === "detached") {
      current.branch = "(detached)";
    }
  }

  if (current.path) worktrees.push(current as WorktreeInfo);

  const mainResult = await execCommand(
    pi,
    "git",
    ["rev-parse", "--show-toplevel"],
    repoPath,
  );
  const mainPath = mainResult.stdout.trim();

  return worktrees.map((w) => ({
    ...w,
    isMain: w.path === mainPath || w.isBare,
  }));
}

// Discover repos in ~/Code
export async function discoverRepos(pi: ExtensionAPI): Promise<RepoInfo[]> {
  const codeDir = join(homedir(), "Code");
  const result = await execCommand(pi, "ls", ["-1", codeDir]);
  if (result.code !== 0) return [];

  const entries = result.stdout
    .split("\n")
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
  const repos: RepoInfo[] = [];

  for (const entry of entries) {
    const fullPath = join(codeDir, entry);
    if (await isGitRepo(pi, fullPath)) {
      const worktrees = await getWorktrees(pi, fullPath);
      repos.push({ path: fullPath, name: entry, worktrees });
    }
  }

  return repos.sort((a, b) => a.name.localeCompare(b.name));
}

// Get current worktree path from git
export async function getCurrentWorktreePath(
  pi: ExtensionAPI,
): Promise<string | null> {
  const result = await execCommand(pi, "git", ["rev-parse", "--show-toplevel"]);
  if (result.code === 0) {
    return result.stdout.trim();
  }
  return null;
}

// Get current commit hash
export async function getCurrentCommit(
  pi: ExtensionAPI,
  repoPath: string,
): Promise<string | null> {
  const result = await execCommand(pi, "git", ["rev-parse", "HEAD"], repoPath);
  if (result.code !== 0) return null;
  return result.stdout.trim();
}

// Check if branch exists
export async function branchExists(
  pi: ExtensionAPI,
  repoPath: string,
  branchName: string,
): Promise<boolean> {
  const result = await execCommand(
    pi,
    "git",
    ["branch", "--list", branchName],
    repoPath,
  );
  return result.code === 0 && result.stdout.trim().length > 0;
}

// Create a new branch
export async function createBranch(
  pi: ExtensionAPI,
  repoPath: string,
  branchName: string,
  baseCommit: string,
): Promise<boolean> {
  const result = await execCommand(
    pi,
    "git",
    ["branch", branchName, baseCommit],
    repoPath,
  );
  return result.code === 0;
}

// Create a new worktree
export async function createWorktree(
  pi: ExtensionAPI,
  repoPath: string,
  worktreePath: string,
  branchName: string,
): Promise<boolean> {
  const result = await execCommand(
    pi,
    "git",
    ["worktree", "add", worktreePath, branchName],
    repoPath,
  );
  return result.code === 0;
}

// Remove a worktree
export async function removeWorktree(
  pi: ExtensionAPI,
  repoPath: string,
  worktreePath: string,
  force = true,
): Promise<boolean> {
  const args = force
    ? ["worktree", "remove", "-f", worktreePath]
    : ["worktree", "remove", worktreePath];
  const result = await execCommand(pi, "git", args, repoPath);
  return result.code === 0;
}

// Delete a branch
export async function deleteBranch(
  pi: ExtensionAPI,
  repoPath: string,
  branchName: string,
  force = true,
): Promise<boolean> {
  const flag = force ? "-D" : "-d";
  const result = await execCommand(
    pi,
    "git",
    ["branch", flag, branchName],
    repoPath,
  );
  return result.code === 0;
}

// Get main worktree branch for display
export function getMainBranch(worktrees: WorktreeInfo[]): string {
  const main = worktrees.find((w) => w.isMain);
  return (
    main?.branch ||
    worktrees.find((w) => w.branch === "main" || w.branch === "master")
      ?.branch ||
    worktrees[0]?.branch ||
    "unknown"
  );
}
