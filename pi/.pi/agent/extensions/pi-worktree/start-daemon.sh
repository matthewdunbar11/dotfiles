#!/bin/bash
# Manual daemon starter for debugging

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DAEMON_PATH="$SCRIPT_DIR/src/daemon/daemon.ts"

echo "Starting pi-worktree daemon..."
echo "Daemon path: $DAEMON_PATH"

# Detect runtime
if command -v deno &> /dev/null; then
    echo "Using Deno runtime"
    exec deno run --allow-all "$DAEMON_PATH"
elif command -v bun &> /dev/null; then
    echo "Using Bun runtime"
    exec bun run "$DAEMON_PATH"
elif command -v tsx &> /dev/null; then
    echo "Using tsx with Node"
    exec node --import tsx "$DAEMON_PATH"
elif command -v ts-node &> /dev/null; then
    echo "Using ts-node"
    exec node -r ts-node/register "$DAEMON_PATH"
else
    echo "ERROR: No TypeScript runtime found!"
    echo "Please install one of: deno, bun, tsx, or ts-node"
    exit 1
fi
