import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { SelectItem } from "../types.ts";
import { Input, matchesKey, Key, truncateToWidth } from "@mariozechner/pi-tui";
import { fuzzyFilter } from "../utils.ts";

// Common UI helpers for picker dialogs

export interface PickerState<T> {
  filteredItems: SelectItem[];
  selectedIndex: number;
  input: Input;
  allItems: SelectItem[];
  lastInputValue: string;
}

// Create initial picker state
export function createPickerState<T extends SelectItem>(
  tui: Parameters<Parameters<ExtensionCommandContext["ui"]["custom"]>[0]>[0],
  items: T[],
): PickerState<T> {
  const input = new Input(tui, {});
  input.focused = true;

  return {
    filteredItems: [...items],
    selectedIndex: 0,
    input,
    allItems: [...items],
    lastInputValue: "",
  };
}

// Update filter based on input
export function updateFilter<T extends SelectItem>(state: PickerState<T>): void {
  const currentValue = state.input.getValue();
  if (currentValue !== state.lastInputValue) {
    state.lastInputValue = currentValue;
    state.filteredItems = fuzzyFilter(state.allItems, currentValue);
    state.selectedIndex = 0;
  }
}

// Handle navigation keys
export function handleNavigation<T>(
  state: PickerState<T>,
  data: string,
  onConfirm: () => void,
  onCancel: () => void,
): boolean {
  if (matchesKey(data, Key.escape)) {
    onCancel();
    return true;
  }

  if (matchesKey(data, Key.enter)) {
    onConfirm();
    return true;
  }

  if (matchesKey(data, Key.down)) {
    if (state.filteredItems.length > 0) {
      state.selectedIndex = (state.selectedIndex + 1) % state.filteredItems.length;
    }
    return true;
  }

  if (matchesKey(data, Key.up)) {
    if (state.filteredItems.length > 0) {
      state.selectedIndex =
        state.selectedIndex === 0
          ? state.filteredItems.length - 1
          : state.selectedIndex - 1;
    }
    return true;
  }

  return false;
}

// Render common picker header
export function renderHeader(
  lines: string[],
  theme: Parameters<Parameters<ExtensionCommandContext["ui"]["custom"]>[0]>[1],
  width: number,
  title: string,
  subtitle?: string,
): void {
  const add = (s: string) => lines.push(truncateToWidth(s, width));
  add(theme.fg("accent", "─".repeat(width)));
  add(theme.fg("accent", theme.bold(` ${title} `)));
  if (subtitle) {
    add(theme.fg("dim", `  ${subtitle}`));
  }
  lines.push("");
}

// Render picker items with selection
export function renderItems(
  lines: string[],
  theme: Parameters<Parameters<ExtensionCommandContext["ui"]["custom"]>[0]>[1],
  width: number,
  state: PickerState<SelectItem>,
  getItemColor?: (item: SelectItem) => string,
): void {
  const add = (s: string) => lines.push(truncateToWidth(s, width));

  if (state.filteredItems.length === 0) {
    add(theme.fg("warning", "  No matches"));
  } else {
    for (let i = 0; i < state.filteredItems.length; i++) {
      const item = state.filteredItems[i];
      const isSelected = i === state.selectedIndex;
      const prefix = isSelected ? theme.fg("accent", "> ") : "  ";

      const label = isSelected
        ? theme.fg("accent", item.label)
        : theme.fg("text", item.label);

      let styledDesc = "";
      if (item.description) {
        const color = getItemColor ? getItemColor(item) : "muted";
        styledDesc = "  " + theme.fg(color as any, item.description);
      }

      add(`${prefix}${label}${styledDesc}`);
    }
  }
}

// Render footer with help text
export function renderFooter(
  lines: string[],
  theme: Parameters<Parameters<ExtensionCommandContext["ui"]["custom"]>[0]>[1],
  width: number,
  helpText: string,
): void {
  const add = (s: string) => lines.push(truncateToWidth(s, width));
  lines.push("");
  add(theme.fg("dim", helpText));
  add(theme.fg("accent", "─".repeat(width)));
}

// Extract status color from item description for worktree display
export function getStatusColor(item: SelectItem): string {
  const description = item.description;
  if (typeof description !== "string") return "muted";
  if (description.startsWith("●")) return "error";
  if (description.startsWith("!")) return "warning";
  if (description.startsWith("○")) return "success";
  return "muted";
}
