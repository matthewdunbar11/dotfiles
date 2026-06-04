import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { execCommand } from "./utils.ts";

// Get list of existing tmux sessions
export async function getTmuxSessions(pi: ExtensionAPI): Promise<string[]> {
  const result = await execCommand(pi, "tmux", ["list-sessions", "-F", "#S"]);
  if (result.code !== 0) return [];
  return result.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Get current tmux session name
export async function getCurrentSession(pi: ExtensionAPI): Promise<string | null> {
  const result = await execCommand(pi, "tmux", [
    "display-message",
    "-p",
    "#{session_name}",
  ]);
  if (result.code === 0) {
    return result.stdout.trim();
  }
  return null;
}

// Set a tmux session option
export async function setSessionOption(
  pi: ExtensionAPI,
  sessionName: string,
  option: string,
  value: string,
): Promise<boolean> {
  const result = await execCommand(pi, "tmux", [
    "set-option",
    "-t",
    sessionName,
    option,
    value,
  ]);
  return result.code === 0;
}

// Get a tmux session option
export async function getSessionOption(
  pi: ExtensionAPI,
  sessionName: string,
  option: string,
): Promise<string | null> {
  const result = await execCommand(pi, "tmux", [
    "show-option",
    "-t",
    sessionName,
    "-v",
    option,
  ]);
  if (result.code === 0) {
    return result.stdout.trim();
  }
  return null;
}

// Attach to or create tmux session for a worktree
export async function attachToSession(
  pi: ExtensionAPI,
  sessionName: string,
  worktreePath: string,
  command = "pi",
): Promise<void> {
  const sessions = await getTmuxSessions(pi);
  const inTmux = process.env.TMUX !== undefined;

  if (sessions.includes(sessionName)) {
    // Session exists - attach to it
    if (inTmux) {
      await execCommand(pi, "tmux", ["switch-client", "-t", sessionName]);
    } else {
      await execCommand(pi, "tmux", ["attach-session", "-t", sessionName]);
    }
  } else {
    // Create new session
    const args = inTmux
      ? ["new-session", "-d", "-s", sessionName, "-c", worktreePath]
      : ["new-session", "-s", sessionName, "-c", worktreePath];
    await execCommand(pi, "tmux", [...args, command]);
    if (inTmux) {
      await execCommand(pi, "tmux", ["switch-client", "-t", sessionName]);
    }
  }
}

// Kill a tmux session
export async function killSession(
  pi: ExtensionAPI,
  sessionName: string,
): Promise<boolean> {
  const result = await execCommand(pi, "tmux", [
    "kill-session",
    "-t",
    sessionName,
  ]);
  return result.code === 0;
}

// Check if currently running in tmux
export function isInTmux(): boolean {
  return process.env.TMUX !== undefined;
}
