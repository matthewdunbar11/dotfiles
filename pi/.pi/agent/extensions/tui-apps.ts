/**
 * TUI Apps Extension
 *
 * Run TUI applications inside pi by suspending the TUI temporarily.
 *
 * Commands:
 *   /yazi [path]     - Launch yazi file manager
 *   /lg              - Launch lazygit
 *   /nvim [path]     - Launch neovim
 *
 * Usage:
 *   /yazi            - Open yazi in current directory
 *   /yazi ~/Projects - Open yazi in specific directory
 *   /lg              - Open lazygit
 *   /nvim            - Open neovim
 *   /nvim file.txt   - Open neovim with specific file
 */

import { spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

function runTUIApp(
  ctx: import("@mariozechner/pi-coding-agent").ExtensionCommandContext,
  command: string,
  args: string[],
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("TUI apps require interactive mode", "error");
    return Promise.resolve();
  }

  return ctx.ui.custom<void>((tui, _theme, _kb, done) => {
    // Stop TUI to release terminal
    tui.stop();

    // Clear screen
    process.stdout.write("\x1b[2J\x1b[H");

    // Run the TUI application with full terminal access
    const result = spawnSync(command, args, {
      stdio: "inherit",
      env: process.env,
      cwd: ctx.cwd,
    });

    // Restart TUI
    tui.start();
    tui.requestRender(true);

    // Signal completion
    done();

    // Return empty component (immediately disposed since done() was called)
    return { render: () => [], invalidate: () => {} };
  });
}

export default function (pi: ExtensionAPI) {
  // /yazi - File manager
  pi.registerCommand("yazi", {
    description: "Launch yazi file manager",
    handler: async (args, ctx) => {
      const path = args.trim() || ctx.cwd;
      ctx.ui.notify(`Launching yazi...`, "info");
      await runTUIApp(ctx, "yazi", [path]);
    },
  });

  // /lg - Lazygit
  pi.registerCommand("lg", {
    description: "Launch lazygit",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`Launching lazygit...`, "info");
      await runTUIApp(ctx, "lazygit", []);
    },
  });

  // /nvim - Neovim
  pi.registerCommand("nvim", {
    description: "Launch neovim",
    handler: async (args, ctx) => {
      const file = args.trim();
      ctx.ui.notify(`Launching neovim...`, "info");
      await runTUIApp(ctx, "nvim", file ? [file] : []);
    },
  });

  // Notify on load
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify(
      "TUI apps ready: /yazi, /lg, /nvim",
      "info",
    );
  });
}
