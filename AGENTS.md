# AGENTS.md – Repository Guidance for Agentic Automation

---

## Table of Contents
1. [Overview](#overview)
2. [Build / Lint / Test Commands](#build--lint--test-commands)
3. [Agent Commands (opencode.json)](#agent-commands-opencodejson)
4. [Code‑Style Guidelines](#code‑style-guidelines)
5.    4.1. [Shell / Zsh / Bash Scripts](#shell‑zsh‑bash-scripts)
6.    4.2. [Lua / Neovim Config](#lua‑neovim-config)
7.    4.3. [Makefile / CI (if added later)](#makefile‑ci)
8.    4.4. [General Naming & Formatting](#general‑naming‑formatting)
9.    4.5. [Error‑Handling Conventions](#error‑handling-conventions)
10. [Cursor / Copilot Rules](#cursor--copilot-rules)
11. [How Agents Should Use This File](#how‑agents‑should‑use‑this-file)
12. [References & External Links](#references--external-links)

---

## Overview
This repository contains **dotfiles** for a macOS development environment.  It is primarily a collection of configuration files, small shell utilities, and plugins.  The file structure is deliberately lightweight, which means there are no compiled binaries, unit‑test suites, or heavy build pipelines.  Nevertheless, agents that automate tasks (e.g., the `opencode` agents) need a clear contract for how to interact with the repo, how to run any available checks, and what style conventions to respect when modifying files.

---

## Build / Lint / Test Commands
| Goal | Command | Description |
|------|---------|-------------|
| **Apply dotfiles** | `./install` | Stow all dotfile folders into `$HOME`.  Uses GNU `stow` and respects the `$STOW_FOLDERS` env var.
| **Dry‑run apply** | `STOW_FOLDERS=aerospace,bin ./install --dry-run` | Shows which files would be symlinked without touching the filesystem (the `--dry-run` flag is supported by newer versions of `stow`).
| **Check for syntax errors (shell)** | `shellcheck **/*.sh` | Run `shellcheck` on every shell script (`*.sh`, `*.zsh`, `*.zshrc`).  Install via `brew install shellcheck` if missing.
| **Validate Zsh config** | `zsh -n $HOME/.zshrc` | Performs a syntax‑only parse of the main Zsh rc file.
| **Validate Lua (Neovim) config** | `luac -p $(find . -name "*.lua")` | Checks that all Lua files are syntactically valid.
| **Run TPM test suite** | `cd tmux/plugins/tpm && ./test` | Executes the TPM (Tmux Plugin Manager) test harness.  The test scripts are self‑contained Bash files.
| **Run all shell tests** | `find . -name "test_*.sh" -exec bash {} \;` | Executes any script prefixed with `test_` that follows the repository convention.
| **Lint Markdown** | `markdownlint **/*.md` | Enforces Markdown style (install via `npm i -g markdownlint-cli`).
| **Check for stray TODOs** | `grep -R "TODO" .` | Simple way to surface unfinished work before committing.

> **Note:** If a command is missing on your system, the repository contains a `Brewfile` that can be used to install the required tools: `brew bundle --file=./Brewfile`.

---
## Agent Commands (opencode.json)

The repository is configured for **opencode** agents via `opencode/.config/opencode/opencode.json`.

> **Important:** Always check https://opencode.ai/docs/config/ before making changes to opencode configuration.

```json
{
  "command": {
    "touch-stacks": { ... },
    "commit": { ... }
  }
}
```

### `touch-stacks`
*Purpose*: Update CloudFormation‑related stack files to force a redeploy after a template change.
*Typical workflow*:
1. Run `git status` – the agent will discover which files under `templates/` changed.
2. Locate the corresponding `stacks/` file(s).
3. Insert or update a comment at the top of each stack file with a timestamp or change description.
4. Commit the change using the `commit` command (see below).

### `commit`
*Purpose*: Automate a well‑formed git commit on a branch that starts with `md/`.
*Key steps performed by the agent*:
- Verify `git config user.name` and `user.email`; set defaults if missing.
- Gather repository status (`git status`, `git diff --stat`).
- Derive a concise commit message (or use `$ARGUMENTS` if supplied).
- Prefix the branch name with `md/`; abort if the current branch does not follow this pattern.
- Stage all changes (`git add .`) and commit with the formatted message.

Agents should **never** push automatically; they must stop after the local commit and report the outcome.

### `lambda-error-investigator`
*Purpose*: Investigate AWS Lambda errors by fetching and analyzing CloudWatch logs.
*Key steps performed by the agent*:
- Accept Lambda function name from `$ARGUMENTS` or prompt user.
- Verify AWS credentials are configured (`aws sts get-caller-identity`).
- Fetch recent CloudWatch logs: `aws logs filter-log-events --log-group /aws/lambda/<name> --filter-pattern "?ERROR ?Exception ?Traceback" --limit 50`
- Analyze logs for error types, stack traces, timestamps, and error messages.
- Determine root cause: code bugs, configuration issues, permission errors, timeouts, memory limits, or dependency problems.
- Provide a summary with error details, location, likely cause, and suggested fix.

*Requirements*: AWS CLI configured with appropriate permissions for CloudWatch Logs.

---

## Code‑Style Guidelines
The following conventions keep the repository tidy, make diffs readable, and reduce friction for automated agents.

### Shell / Zsh / Bash Scripts
| Aspect | Guideline |
|--------|-----------|
| **Indentation** | Use **2 spaces** per level (no tabs).  Align continuation lines with two additional spaces.
| **Shebang** | Always include an explicit interpreter (`#!/usr/bin/env zsh` or `#!/usr/bin/env bash`).
| **Quotes** | Prefer **double quotes** for variable interpolation, **single quotes** for literals.  Escape only when necessary.
| **Variable naming** | Upper‑case for environment variables (`MY_VAR`).  Lowercase for local script variables (`my_path`).
| **Error handling** | `set -euo pipefail` at the top of scripts that need strict failure semantics.  Use `|| true` when a non‑zero exit is intentional.
| **Function naming** | `snake_case` for functions, prefixed with the domain when appropriate (e.g., `tmux_plugin_install`).
| **Return values** | Functions should `return 0` on success, non‑zero on failure.  Use `printf` for output.
| **Logging** | Use a simple `log()` helper that prefixes messages with `[INFO]` or `[ERROR]` and writes to `stderr` for errors.
| **ShellCheck compliance** | Run `shellcheck` locally; fix all warnings marked as **error**.  Warnings may be suppressed with `# shellcheck disable=SCxxxx` when absolutely necessary.

### Lua / Neovim Config
| Aspect | Guideline |
|--------|-----------|
| **Indentation** | 2 spaces; avoid tabs.
| **Global namespace** | Keep the global namespace clean – wrap plugin config in a local table or `require`‑based modules.
| **Naming** | Use `camelCase` for functions (`setupLsp`) and `snake_case` for variables (`plugin_opts`).
| **Module layout** | Each plugin gets its own file under `lua/` (e.g., `lua/lazyvim/plugins/xxxx.lua`).  The top‑level `init.lua` should only bootstrap the plugin manager.
| **Error handling** | Use `pcall` when requiring optional modules; log failures with `vim.notify`.
| **Formatting** | Follow `stylua` conventions (install via `brew install stylua`).  Run `stylua .` before committing.

### Makefile / CI (Future‑Proofing)
If a `Makefile` is added later, enforce:
- Tabs for command lines (required by make).
- Targets `all`, `install`, `test`, `lint`.
- `PHONY` declarations for each target.
- Use `brew bundle` to install dependencies.

### General Naming & Formatting
- **Files**: snake_case (`my_script.sh`, `init.lua`).  Use extensions that match the interpreter.
- **Directories**: lowercase, hyphen‑separated if multi‑word (`dotfiles`, `tmux-plugins`).
- **Commit messages**: `[branch] Short description` – keep under 72 characters.
- **Line length**: Soft limit of **80 characters** for code and comments.
- **Trailing whitespace**: Never commit trailing spaces; configure the editor to trim on save.
- **Blank lines**: Separate logical sections with a single blank line.

---

## Error‑Handling Conventions
1. **Shell scripts** – exit on any error unless explicitly handled.
2. **Functions** – return error codes; callers must check `$?`.
3. **Lua** – guard `require` with `pcall`; propagate errors up the call stack.
4. **Git automation** – abort on unexpected status (e.g., dirty working tree when a clean state is required).
5. **Agent failures** – agents must emit a clear, machine‑readable JSON payload on error, containing `error`, `step`, and optionally `suggested_fix`.

---

## Cursor / Copilot Rules
The repository does **not** contain a `.cursor/` directory or a `.cursorrules` file, nor does it have a `.github/copilot-instructions.md`.  Therefore there are no explicit custom rules for Cursor or GitHub Copilot.  Agents should fall back to the **default** behavior of those tools:
- Prefer concise suggestions.
- Do not overwrite existing comments unless the user explicitly authorizes it.
- Respect the `.gitignore` (currently only `.git/` itself).

If such files are added in the future, this section should be updated accordingly.

---

## How Agents Should Use This File
1. **Read‑only reference** – agents must treat `AGENTS.md` as authoritative documentation; any deviation should be flagged as a warning.
2. **Pre‑commit checks** – before writing a file, an agent should verify that its changes obey the style rules (indentation, naming, lint).  Running the appropriate linter command programmatically is recommended.
3. **Command discovery** – agents can parse the *Build / Lint / Test Commands* table to discover which CLI tools are available and present them to the user if a request is ambiguous.
4. **Commit workflow** – when invoking the `commit` opencode command, agents must ensure the branch naming rule (`md/…`) is satisfied and that the commit message follows the format described above.
5. **Extensibility** – if a new language or tool is added (e.g., Python scripts), contributors should extend the relevant sections of this document and agents will automatically pick up the new guidelines.

---

## References & External Links
- **ShellCheck** – https://www.shellcheck.net/
- **stylua** – https://github.com/JohnnyMorganz/StyLua
- **GNU Stow** – https://www.gnu.org/software/stow/
- **Opencode Agent Docs** – https://opencode.ai/docs/agents (placeholder link)
- **Markdownlint** – https://github.com/markdownlint/markdownlint

*Generated by an autonomous opencode agent on $(date)*
