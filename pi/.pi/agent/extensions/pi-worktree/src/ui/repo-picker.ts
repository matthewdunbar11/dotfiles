import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { RepoInfo, SelectItem, SessionStatus } from "../types.ts";
import { truncateToWidth } from "@mariozechner/pi-tui";
import { StatusService } from "../status.ts";
import { getMainBranch } from "../git.ts";
import {
  createPickerState,
  updateFilter,
  handleNavigation,
  renderHeader,
  renderItems,
  renderFooter,
  getStatusColor,
} from "./common.ts";

// Show repo selection dialog
export async function selectRepo(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  repos: RepoInfo[],
): Promise<RepoInfo | null> {
  if (repos.length === 0) {
    ctx.ui.notify("No git repos found in ~/Code", "warning");
    return null;
  }

  const statusService = new StatusService(pi);

  // Build items with rolled-up status indicators
  const allItems: SelectItem[] = await Promise.all(
    repos.map(async (r) => {
      const { indicator } = await statusService.getRepoStatus(r);
      const mainBranch = getMainBranch(r.worktrees);
      const statusPrefix = indicator ? `${indicator} ` : "";
      return {
        value: r.path,
        label: r.name,
        description: `${statusPrefix}${r.worktrees.length} worktrees (${mainBranch})`,
      };
    }),
  );

  return new Promise((resolve) => {
    ctx.ui.custom<RepoInfo | null>((tui, theme, _kb, done) => {
      const state = createPickerState(tui, allItems);
      let cachedLines: string[] | undefined;
      let refreshInterval: ReturnType<typeof setInterval> | null = null;

      // Start periodic refresh of status indicators
      async function refreshStatuses() {
        const updatedItems = await Promise.all(
          repos.map(async (r) => {
            const { indicator } = await statusService.getRepoStatus(r);
            const mainBranch = getMainBranch(r.worktrees);
            const statusPrefix = indicator ? `${indicator} ` : "";
            return {
              value: r.path,
              label: r.name,
              description: `${statusPrefix}${r.worktrees.length} worktrees (${mainBranch})`,
            };
          }),
        );

        // Update items if changed
        const currentDescs = state.allItems.map(i => i.description).join("|");
        const newDescs = updatedItems.map(i => i.description).join("|");
        if (currentDescs !== newDescs) {
          state.allItems.length = 0;
          state.allItems.push(...updatedItems);
          // Re-apply filter
          const currentValue = state.input.getValue();
          state.filteredItems = currentValue 
            ? state.allItems.filter(i => 
                i.label.toLowerCase().includes(currentValue.toLowerCase()) ||
                (i.description?.toLowerCase() || "").includes(currentValue.toLowerCase())
              )
            : [...state.allItems];
          cachedLines = undefined;
          tui.requestRender();
        }
      }

      // Start polling
      refreshInterval = setInterval(() => {
        refreshStatuses().catch(() => {});
      }, 3000);

      function render(width: number): string[] {
        updateFilter(state);

        if (cachedLines) return cachedLines;

        const lines: string[] = [];
        const add = (s: string) => lines.push(truncateToWidth(s, width));

        renderHeader(lines, theme, width, "Select Repository", "● busy  ! waiting  ○ idle (auto-refreshing)");

        // Search input
        for (const line of state.input.render(width - 2)) {
          add(" " + line);
        }
        lines.push("");

        renderItems(lines, theme, width, state, getStatusColor);
        renderFooter(
          lines,
          theme,
          width,
          "Type to filter • ↑↓ navigate • Enter to select • Esc to cancel",
        );

        cachedLines = lines;
        return lines;
      }

      function confirmSelection() {
        if (refreshInterval) {
          clearInterval(refreshInterval);
          refreshInterval = null;
        }
        if (state.filteredItems.length > 0) {
          const item = state.filteredItems[state.selectedIndex];
          const repo = repos.find((r) => r.path === item.value);
          done(repo || null);
        }
      }

      state.input.onSubmit = confirmSelection;

      return {
        render,
        invalidate: () => {
          cachedLines = undefined;
          state.input.invalidate();
        },
        handleInput: (data: string) => {
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
