/**
 * Run Command Extension
 *
 * /run <command> — runs a bash command, injects the command + output into
 * message history with the same rendering style as the built-in bash tool.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 10_000;
const PREVIEW_LINES = 20;

function shortenOutput(output: string): string {
  return output.length > MAX_OUTPUT_CHARS
    ? `${output.slice(0, MAX_OUTPUT_CHARS)}\n... (truncated, ${output.length} chars total)`
    : output;
}

export default function (pi: ExtensionAPI) {
  // Register the custom message renderer (run messages)
  pi.registerMessageRenderer("run", (message, { expanded }, theme) => {
    const details = message.details as
      | {
          exitCode: number;
          command: string;
          truncated: boolean;
          output: string;
        }
      | undefined;
    const output = details?.output ?? "";
    const exitCode = details?.exitCode ?? 0;
    const truncated = details?.truncated ?? false;
    const command = details?.command ?? message.content ?? "";
    const availableLines = output ? output.split("\n") : [];

    // Preview (collapsed): show last N lines
    const previewLogicalLines = availableLines.slice(-PREVIEW_LINES);
    const hiddenLineCount = availableLines.length - previewLogicalLines.length;

    // Build the text content
    let text = theme.fg("toolTitle", "[run] ");
    text += `\n\n${theme.fg("bashMode", theme.bold(`$ ${command}`))}`;

    if (availableLines.length > 0) {
      if (expanded) {
        const displayText = previewLogicalLines.join("\n");
        text += `\n${displayText}`;
      } else {
        const styledOutput = previewLogicalLines.join("\n");
        text += `\n${styledOutput}`;
      }
    }

    // Status line (hidden count or exit code)
    if (hiddenLineCount > 0 && !expanded) {
      text += `\n${theme.fg("muted", `... ${hiddenLineCount} more lines`)}`;
    }
    if (exitCode !== 0 && exitCode !== undefined) {
      text += `\n${theme.fg("error", `(exit ${exitCode})`)}`;
    }
    if (truncated) {
      text += `\n${theme.fg("warning", "Output truncated.")}`;
    }

    const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
    box.addChild(new Text(text, 0, 0));
    return box;
  });

  // /run command
  pi.registerCommand("run", {
    description: "Run an arbitrary bash command (output logged to history)",
    handler: async (args, ctx) => {
      const command = args?.trim();
      if (!command) {
        ctx.ui.notify("Usage: /run <command>", "info");
        return;
      }

      try {
        const result = await pi.exec("bash", ["-c", command], {
          cwd: ctx.cwd,
          timeout: DEFAULT_TIMEOUT_MS,
        });

        const output = result.stdout || result.stderr || "";
        const truncated = output.length > MAX_OUTPUT_CHARS;
        const displayOutput = shortenOutput(output);

        // Inject into message history with custom styling
        const commandLabel =
          command.length > 60 ? `${command.slice(0, 57)}...` : command;

        pi.sendMessage(
          {
            customType: "run",
            content: commandLabel,
            display: true,
            details: {
              exitCode: result.code,
              command,
              truncated,
              output: truncated ? displayOutput : output,
            },
          },
          { triggerTurn: false },
        );

        if (result.code !== 0) {
          ctx.ui.notify(`Command failed (exit ${result.code})`, "error");
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Execution failed:\n${msg}`, "error");
      }
    },
  });
}
