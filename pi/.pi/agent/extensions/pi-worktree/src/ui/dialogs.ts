import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { RepoInfo, WorktreeInfo } from "../types.ts";
import { Input, matchesKey, Key, truncateToWidth } from "@mariozechner/pi-tui";

// Dialog to create a new worktree
export async function createWorktreeDialog(
  ctx: ExtensionCommandContext,
  repo: RepoInfo,
): Promise<string | null> {
  return new Promise((resolve) => {
    ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
      let cachedLines: string[] | undefined;
      let lastInputValue = "";

      const input = new Input(tui, {});
      input.placeholder = "feature/my-branch";
      input.focused = true;

      input.onSubmit = () => {
        const branchName = input.getValue().trim();
        if (branchName) {
          done(branchName);
        }
      };

      function render(width: number): string[] {
        const currentValue = input.getValue();
        if (currentValue !== lastInputValue) {
          lastInputValue = currentValue;
          cachedLines = undefined;
        }

        if (cachedLines) return cachedLines;

        const lines: string[] = [];
        const add = (s: string) => lines.push(truncateToWidth(s, width));

        add(theme.fg("accent", "─".repeat(width)));
        add(theme.fg("accent", theme.bold(" Create New Worktree ")));
        add(theme.fg("muted", `  Repository: ${repo.name}`));
        lines.push("");
        add(theme.fg("text", "  Branch name:"));

        for (const line of input.render(width - 4)) {
          add("  " + line);
        }

        lines.push("");
        add(theme.fg("dim", "  Enter to confirm • Esc to cancel"));
        add(theme.fg("accent", "─".repeat(width)));

        cachedLines = lines;
        return lines;
      }

      return {
        render,
        invalidate: () => {
          cachedLines = undefined;
          input.invalidate();
        },
        handleInput: (data: string) => {
          if (matchesKey(data, Key.escape)) {
            done(null);
            return;
          }
          input.handleInput(data);
        },
        focused: false,
      };
    }).then(resolve);
  });
}

// Simple info dialog
export async function showInfo(
  ctx: ExtensionCommandContext,
  title: string,
  message: string,
): Promise<void> {
  return new Promise((resolve) => {
    ctx.ui.custom<void>((tui, theme, _kb, done) => {
      function render(width: number): string[] {
        const lines: string[] = [];
        const add = (s: string) => lines.push(truncateToWidth(s, width));

        add(theme.fg("accent", "─".repeat(width)));
        add(theme.fg("accent", theme.bold(` ${title} `)));
        lines.push("");
        add(theme.fg("text", `  ${message}`));
        lines.push("");
        add(theme.fg("dim", "  Press any key to continue"));
        add(theme.fg("accent", "─".repeat(width)));

        return lines;
      }

      return {
        render,
        invalidate: () => {},
        handleInput: () => {
          done();
        },
        focused: false,
      };
    }).then(resolve);
  });
}
