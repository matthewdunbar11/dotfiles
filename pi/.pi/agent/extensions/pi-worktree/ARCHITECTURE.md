# pi-worktree Architecture

## Overview

pi-worktree uses a **daemon-client architecture** to eliminate redundant work across multiple pi sessions. The daemon runs as a single background process that handles all git scanning and status polling. Pi sessions connect to the daemon via Unix socket for instant responses.

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        pi Session 1                              │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Extension                                                │  │
│  │  - Uses daemon client for all data                       │  │
│  │  - Writes status to tmux directly                        │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────┬───────────────────────────────────────┘
                          │ Unix Socket (/tmp/pi-worktree-daemon-${uid}.sock)
                          │
┌─────────────────────────┼───────────────────────────────────────┐
│                        pi Session 2                              │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Extension                                                │  │
│  │  - Reuses same daemon client (singleton)                 │  │
│  │  - Writes status to tmux directly                        │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────┬───────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                     WorktreeDaemon                               │
│  ┌─────────────────┐  ┌─────────────────┐  ┌──────────────────┐  │
│  │  Repo Scanner   │  │  Status Poller  │  │  IPC Server      │  │
│  │  - Scans ~/Code │  │  - Reads tmux   │  │  - Unix socket   │  │
│  │  - Caches repos │  │  - Tracks all   │  │  - NDJSON        │  │
│  │  - 30s interval │  │  - 5s interval  │  │  - Pub/sub       │  │
│  └─────────────────┘  └─────────────────┘  └──────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                          │
                          ▼
                    ┌──────────────┐
                    │   tmux       │
                    │  (sessions)  │
                    └──────────────┘
```

## Module Structure

```
src/
├── daemon/
│   ├── protocol.ts       # Message types and socket paths
│   ├── daemon.ts         # Background daemon process
│   ├── client.ts         # Client to connect to daemon
│   └── index.ts          # Exports
├── types.ts              # Shared interfaces
├── utils.ts              # Shell execution, fuzzy filter
├── git.ts                # Git operations (git commands)
├── tmux.ts               # Tmux operations
├── status.ts             # StatusService (writes to tmux)
├── ui/                   # UI components
│   ├── common.ts
│   ├── repo-picker.ts
│   ├── worktree-picker.ts
│   └── dialogs.ts
├── commands/
│   ├── worktree.ts       # /wt command
│   └── status.ts         # /wt-status command
└── index.ts              # Extension entry point
```

## Daemon Protocol

The daemon uses **newline-delimited JSON** over a Unix domain socket.

### Request Types
```typescript
type DaemonRequest =
  | { type: "ping" }
  | { type: "getRepos" }                    // Returns cached repos
  | { type: "getStatus"; worktreePath: string }
  | { type: "getAllStatuses" }
  | { type: "refreshRepos" }                // Force rescan
  | { type: "refreshStatuses" }             // Force status refresh
  | { type: "subscribe"; event: "statusChange" | "waitingChange" }
  | { type: "unsubscribe"; event: "statusChange" | "waitingChange" };
```

### Response Types
```typescript
type DaemonResponse =
  | { type: "pong"; timestamp: number }
  | { type: "repos"; repos: RepoInfo[] }
  | { type: "status"; worktreePath: string; status: SessionStatusData | null }
  | { type: "allStatuses"; statuses: Array<{worktreePath: string, data: SessionStatusData}> }
  | { type: "ok" }
  | { type: "error"; message: string }
  | { type: "event"; event: "statusChange" | "waitingChange"; data: unknown };
```

## Key Design Decisions

### 1. Daemon Lifecycle
- **Auto-start**: First pi session starts the daemon if not running
- **Singleton**: Lock file prevents duplicate daemons (`/tmp/pi-worktree-daemon-${uid}.lock`)
- **Socket**: User-specific Unix socket (`/tmp/pi-worktree-daemon-${uid}.sock`)
- **Cleanup**: Daemon removes socket on SIGTERM/SIGINT

### 2. Data Flow
- **Read-heavy operations** (repo discovery, status reading): Handled by daemon, cached in memory
- **Write operations** (status updates): Each pi session writes directly to tmux (session-specific)
- **Real-time updates**: Daemon subscribes to status changes, broadcasts to connected clients

### 3. Concurrency
- **Repo scanning**: 10 concurrent git operations
- **Status polling**: 20 concurrent tmux reads
- **Polling intervals**: 30s for repos, 5s for statuses

### 4. Fallback Strategy
If daemon connection fails:
1. Extension attempts to reconnect (with backoff)
2. Git operations can still work directly (for critical paths)
3. Status bar gracefully degrades

## Usage Examples

### From Extension
```typescript
import { getGlobalClient } from "./daemon/client.ts";

const client = getGlobalClient();
await client.connect();  // Starts daemon if needed

// Get cached repos (instant)
const repos = await client.getRepos();

// Subscribe to events
client.onWaitingChange((count, repos) => {
  updateStatusBar(count, repos);
});
```

### Direct Daemon Control
```bash
# Start daemon manually
node --import tsx src/daemon/daemon.ts

# Check if running
nc -U /tmp/pi-worktree-daemon-$(id - u).sock
```

## Migration from v1

The daemon architecture replaces the old polling-based approach:

| Old (v1) | New (v2) |
|----------|----------|
| Each pi session scans repos independently | Daemon scans once, all sessions use cache |
| Polling.ts with 5s interval per session | Daemon polls, pushes events to subscribers |
| StatusService reads from tmux every call | Daemon maintains in-memory status map |
| 54 repos × 2 git calls × N sessions | 54 repos × 2 git calls × 1 daemon |

## Performance

With 54 repos in ~/Code:
- **v1 (sequential)**: ~5-10 seconds per scan
- **v1 (parallel batches)**: ~1-2 seconds per scan  
- **v2 (daemon, cached)**: ~10-50 milliseconds (instant from memory)

Daemon background scan: ~500ms every 30 seconds (unnoticeable)

## Security

- Unix socket permissions: `0o600` (user-only)
- Lock file prevents cross-user conflicts
- No network access (Unix socket only)
- Daemon runs with same privileges as pi
