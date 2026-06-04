import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { RepoInfo, WorktreeInfo, SelectItem } from "../types.ts";
import { truncateToWidth } from "@mariozechner/pi-tui";
import { StatusService } from "../status.ts";
import {
  createPickerState,
  updateFilter,
  handleNavigation,
  renderHeader,
  renderItems,
  renderFooter,
  getStatusColor,
} from "./common.ts";

export interface WorktreeSelection {
  worktree: WorktreeInfo;
  isNew: boolean;
}

// Show worktree selection dialog
export async function selectWorktree(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  initialRepo: RepoInfo,
): Promise<WorktreeSelection | null> {
  const statusService = new StatusService(pi);
  let repo = initialRepo;

  // Build items with status indicators
  async function buildItems(): Promise<SelectItem[]> {
    const worktreeItems = await Promise.all(
      repo.worktrees.map(async (w) => {
        try {
          const statusData = await statusService.read(w.path);
          const status = statusData?.status ?? null;

          const location = w.isMain
            ? "(main)"
            : w.path.replace(repo.path, "").replace(/^\//, "") || ".";

          const statusIndicator =
            status === "busy" ? "● " : status === "waiting" ? "! " : status === "idle" ? "○ " : "";

          return {
            value: w.path,
            label: w.branch,
            description: `${statusIndicator}${location}`,
          };
        } catch (e) {
          // If we can't read status (e.g., worktree was deleted), show as missing
          return {
            value: w.path,
            label: w.branch,
            description: "(missing)",
          };
        }
      }),
    );

    return [
      ...worktreeItems,
      {
        value: "__new__",
        label: "+ Create new worktree",
        description: "Create a new branch and worktree",
      },
    ];
  }

  let allItems: SelectItem[];
  try {
    allItems = await buildItems();
  } catch (err) {
    console.error("[wt] Failed to build worktree items:", err);
    ctx.ui.notify(`Failed to load worktrees: ${err instanceof Error ? err.message : String(err)}`, "error");
    return null;
  }

  return new Promise((resolve) => {
    ctx.ui.custom<WorktreeSelection | null>((tui, theme, _kb, done) => {
      const state = createPickerState(tui, allItems);
      let cachedLines: string[] | undefined;
      let refreshInterval: ReturnType<typeof setInterval> | null = null;

      async function refreshItems() {
        const newItems = await buildItems();
        // Check if anything changed before updating
        const currentDescs = state.allItems.map(i => i.description).join("|");
        const newDescs = newItems.map(i => i.description).join("|");
        if (currentDescs !== newDescs) {
          state.allItems.length = 0;
          state.allItems.push(...newItems);
          // Re-apply filter
          const currentValue = state.input.getValue();
          state.filteredItems = currentValue
            ? state.allItems.filter(i =>
                i.label.toLowerCase().includes(currentValue.toLowerCase()) ||
                (i.description?.toLowerCase() || "").includes(currentValue.toLowerCase())
              )
            : [...state.allItems];
          state.selectedIndex = Math.min(state.selectedIndex, state.filteredItems.length - 1);
          cachedLines = undefined;
          tui.requestRender();
        }
      }

      // Start polling for status changes
      refreshInterval = setInterval(() => {
        refreshItems().catch((err) => {
          console.error("[wt] Refresh error:", err);
        });
      }, 3000);

      function render(width: number): string[] {
        try {
          updateFilter(state);

          if (cachedLines) return cachedLines;

          const lines: string[] = [];
          const add = (s: string) => lines.push(truncateToWidth(s, width));

          renderHeader(lines, theme, width, `Worktrees: ${repo.name}`, "● busy  ! waiting  ○ idle (auto-refreshing)");

          for (const line of state.input.render(width - 2)) {
            add(" " + line);
          }
          lines.push("");

          renderItems(lines, theme, width, state, getStatusColor);
          renderFooter(
            lines,
            theme,
            width,
            "Type to filter • ↑↓ navigate • Enter to select • Delete to remove • Esc to go back",
          );

          cachedLines = lines;
          return lines;
        } catch (err) {
          console.error("[wt] Render error:", err);
          return [`Error: ${err instanceof Error ? err.message : String(err)}`];
        }
      }

      function confirmSelection() {
        if (refreshInterval) {
          clearInterval(refreshInterval);
          refreshInterval = null;
        }
        if (state.filteredItems.length > 0) {
          const item = state.filteredItems[state.selectedIndex];
          if (item.value === "__new__") {
            done({ worktree: null as unknown as WorktreeInfo, isNew: true });
          } else {
            const worktree = repo.worktrees.find((w) => w.path === item.value);
            done(worktree ? { worktree, isNew: false } : null);
          }
        }
      }

      state.input.onSubmit = confirmSelection;

      return {
        render,
        invalidate: () => {
          cachedLines = undefined;
          state.input.invalidate();
        },
        handleInput: async (data: string) => {
          // Handle delete key (various terminal codes)
          // \x7f = DEL (127), \x08 = BS (8), \x1b[3~ = Delete key sequence
          if (data === "\x7f" || data === "\x08" || data === "\x1b[3~" || data.includes("[3~")) {
            if (state.filteredItems.length > 0) {
              const item = state.filteredItems[state.selectedIndex];
              if (item.value === "__new__") {
                ctx.ui.notify("Cannot delete the 'Create new worktree' option", "warning");
                return;
              }

              const worktree = repo.worktrees.find((w) => w.path === item.value);
              if (!worktree) return;

              if (worktree.isMain) {
                ctx.ui.notify("Cannot delete the main worktree", "warning");
                return;
              }

              const confirmed = await confirmDelete(ctx, worktree);
              if (confirmed) {
                const { killSession } = await import("../tmux.ts");
                const { removeWorktree, deleteBranch } = await import("../git.ts");

                // Kill tmux session
                const sessionName = await statusService.findSessionByWorktree(worktree.path);
                if (sessionName) {
                  await killSession(pi, sessionName);
                }

                // Remove worktree
                const removed = await removeWorktree(pi, repo.path, worktree.path);
                if (!removed) {
                  ctx.ui.notify("Failed to delete worktree", "error");
                  return;
                }

                // Try to delete branch
                const branchDeleted = await deleteBranch(pi, repo.path, worktree.branch, true);
                if (!branchDeleted) {
                  ctx.ui.notify(`Worktree deleted but branch '${worktree.branch}' remains`, "warning");
                } else {
                  ctx.ui.notify(`Deleted worktree: ${worktree.branch}`, "success");
                }

                // Refresh repo data from git (re-read worktrees list)
                const { getWorktrees } = await import("../git.ts");
                const updatedWorktrees = await getWorktrees(pi, repo.path);
                repo.worktrees = updatedWorktrees;

                // Close picker after delete so user can run /wt again fresh
                // (pi's UI system can only have one custom dialog at a time)
                if (refreshInterval) {
                  clearInterval(refreshInterval);
                  refreshInterval = null;
                }
                done(null);
              }
            }
            return;
          }

          if (handleNavigation(state, data, confirmSelection, () => {
            if (refreshInterval) {
              clearInterval(refreshInterval);
              refreshInterval = null;
            }
            done(null);
          })) {
            cachedLines = undefined;
            tui.requestRender();
            return;
          }

          // Handle text input - must invalidate cache and re-render
          state.input.handleInput(data);
          cachedLines = undefined;
          tui.requestRender();
        },
        focused: false,
      };
    }).then(resolve);
  });
}

// Confirmation dialog for delete
async function confirmDelete(
  ctx: ExtensionCommandContext,
  worktree: WorktreeInfo,
): Promise<boolean> {
  return new Promise((resolve) => {
    ctx.ui.custom<boolean>((tui, theme, _kb, done) => {
      let cachedLines: string[] | undefined;

      function render(width: number): string[] {
        if (cachedLines) return cachedLines;

        const lines: string[] = [];
        const add = (s: string) => lines.push(truncateToWidth(s, width));

        add(theme.fg("accent", "─".repeat(width)));
        add(theme.fg("error", theme.bold(" Delete Worktree? ")));
        lines.push("");
        add(theme.fg("text", `  Branch: ${worktree.branch}`));
        add(theme.fg("text", `  Path: ${worktree.path}`));
        lines.push("");
        add(theme.fg("warning", "  This will delete the worktree and kill the tmux session."));
        add(theme.fg("warning", "  Uncommitted changes will be lost!"));
        lines.push("");
        add(theme.fg("dim", "  Y to confirm • N or Esc to cancel"));
        add(theme.fg("accent", "─".repeat(width)));

        cachedLines = lines;
        return lines;
      }

      return {
        render,
        invalidate: () => {
          cachedLines = undefined;
        },
        handleInput: (data: string) => {
          if (data.toLowerCase() === "n" || data === "\x1b") {
            done(false);
            return;
          }
          if (data.toLowerCase() === "y" || data === "\r") {
            done(true);
            return;
          }
        },
        focused: false,
      };
    }).then(resolve);
  });
}
