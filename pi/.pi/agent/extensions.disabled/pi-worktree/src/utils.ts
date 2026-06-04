import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CommandResult, SelectItem } from "./types.ts";
import { basename } from "node:path";

// Execute shell command helper
export async function execCommand(
  pi: ExtensionAPI,
  command: string,
  args: string[],
  cwd?: string,
): Promise<CommandResult> {
  try {
    const result = await pi.exec(command, args, { cwd });
    return {
      stdout: result.stdout || "",
      stderr: result.stderr || "",
      code: result.code ?? 0,
    };
  } catch (e) {
    return {
      stdout: "",
      stderr: e instanceof Error ? e.message : String(e),
      code: 1,
      error: e instanceof Error ? e : new Error(String(e)),
    };
  }
}

// Fuzzy filter function
export function fuzzyFilter<T extends { label: string; description?: string }>(
  items: T[],
  query: string,
): T[] {
  if (!query.trim()) return items;

  const lowerQuery = query.toLowerCase();
  const scored = items.map((item) => {
    const label = item.label.toLowerCase();
    const desc = item.description?.toLowerCase() || "";

    let score = 0;
    if (label.startsWith(lowerQuery)) score += 100;
    else if (label.includes(lowerQuery)) score += 50;
    else {
      let queryIdx = 0;
      for (let i = 0; i < label.length && queryIdx < lowerQuery.length; i++) {
        if (label[i] === lowerQuery[queryIdx]) queryIdx++;
      }
      if (queryIdx === lowerQuery.length) score += 25;
    }
    if (desc.includes(lowerQuery)) score += 10;

    return { item, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.item);
}

// Generate tmux session name from worktree path
// Legacy naming - prefer using @pi-worktree option instead
export function getSessionName(worktreePath: string): string {
  // Handle ~/.worktrees/<repo>/<branch> pattern
  if (worktreePath.includes(".worktrees")) {
    const parts = worktreePath.split("/");
    const worktreesIndex = parts.indexOf(".worktrees");
    if (worktreesIndex >= 0 && parts.length > worktreesIndex + 2) {
      const repoName = parts[worktreesIndex + 1];
      const worktreeName = parts[worktreesIndex + 2];
      return `${repoName}-${worktreeName}`;
    }
  }

  // Handle ~/Code/<repo> pattern (main worktree)
  if (worktreePath.includes("Code")) {
    const parts = worktreePath.split("/");
    const codeIndex = parts.indexOf("Code");
    if (codeIndex >= 0 && parts.length > codeIndex + 1) {
      return parts[codeIndex + 1];
    }
  }

  // Fallback: use basename
  return basename(worktreePath);
}
