/**
 * pi-worktree daemon
 * Background process that manages repo discovery and status polling
 * Communicates via Unix domain socket using newline-delimited JSON
 */

import { createServer, createConnection, type Server, type Socket } from "node:net";
import { existsSync, unlinkSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { RepoInfo, SessionStatusData } from "../types.ts";
import { discoverRepos } from "../git.ts";
import { StatusService } from "../status.ts";
import {
  type DaemonRequest,
  type DaemonResponse,
  type DaemonState,
  type DaemonClient,
  getSocketPath,
  getLockFilePath,
} from "./protocol.ts";

// Mock ExtensionAPI for daemon context
const mockPi = {
  exec: async (command: string, args: string[], options?: { cwd?: string }) => {
    const { execFile } = await import("node:child_process");
    return new Promise((resolve, reject) => {
      execFile(command, args, { cwd: options?.cwd }, (error, stdout, stderr) => {
        if (error && !stdout) {
          reject(error);
        } else {
          resolve({
            stdout: stdout.toString(),
            stderr: stderr.toString(),
            code: error?.code || 0,
          });
        }
      });
    });
  },
} as ExtensionAPI;

// Configuration
const REPO_POLL_INTERVAL_MS = 30000; // 30 seconds
const STATUS_POLL_INTERVAL_MS = 5000; // 5 seconds
const CACHE_TTL_MS = 60000; // 1 minute

class WorktreeDaemon {
  private server: Server | null = null;
  private state: DaemonState;
  private clients = new Set<Socket>();
  private repoPollTimer: NodeJS.Timeout | null = null;
  private statusPollTimer: NodeJS.Timeout | null = null;
  private statusService: StatusService;

  constructor() {
    this.state = {
      repos: [],
      reposLastUpdated: 0,
      statuses: new Map(),
      waitingCount: 0,
      waitingRepos: [],
      subscribers: new Map(),
    };
    this.statusService = new StatusService(mockPi);
  }

  async start(): Promise<void> {
    // Check if already running
    if (await this.isAlreadyRunning()) {
      console.error("Daemon already running");
      process.exit(1);
    }

    // Create lock file
    this.createLockFile();

    // Clean up old socket
    const socketPath = getSocketPath();
    if (existsSync(socketPath)) {
      try {
        unlinkSync(socketPath);
      } catch {
        // Ignore
      }
    }

    // Create server
    this.server = createServer((socket) => {
      this.handleConnection(socket);
    });

    // Start listening immediately so client can connect
    await new Promise<void>((resolve, reject) => {
      this.server!.listen(socketPath, () => {
        console.log(`Daemon listening on ${socketPath}`);
        resolve();
      });
      this.server!.on("error", reject);
    });

    // Set permissions so only user can access
    try {
      const { chmod } = await import("node:fs/promises");
      await chmod(socketPath, 0o600);
    } catch {
      // Ignore chmod errors
    }

    // Do initial scan in background so we don't block clients
    this.refreshRepos().then(() => {
      this.refreshStatuses();
    });

    // Start background polling
    this.startPolling();

    // Handle signals
    process.on("SIGTERM", () => this.stop());
    process.on("SIGINT", () => this.stop());
    process.on("exit", () => this.cleanup());
  }

  private async isAlreadyRunning(): Promise<boolean> {
    const socketPath = getSocketPath();
    if (!existsSync(socketPath)) return false;

    // Try to connect and send a ping
    return new Promise((resolve) => {
      try {
        const socket = createConnection(socketPath);
        let buffer = "";
        
        const timeout = setTimeout(() => {
          socket.destroy();
          resolve(false); // No response, daemon not actually running
        }, 1000);

        socket.on("connect", () => {
          socket.write(JSON.stringify({ type: "ping" }) + "\n");
        });

        socket.on("data", (data) => {
          buffer += data.toString();
          const lines = buffer.split("\n");
          for (const line of lines) {
            if (line.trim()) {
              try {
                const response = JSON.parse(line);
                if (response.type === "pong") {
                  clearTimeout(timeout);
                  socket.end();
                  resolve(true); // Got pong, daemon is running
                  return;
                }
              } catch {
                // Ignore parse errors
              }
            }
          }
        });

        socket.on("error", () => {
          clearTimeout(timeout);
          resolve(false); // Connection failed, daemon not running
        });

        socket.on("close", () => {
          clearTimeout(timeout);
          resolve(false);
        });
      } catch {
        resolve(false);
      }
    });
  }

  private createLockFile(): void {
    const lockFile = getLockFilePath();
    writeFileSync(lockFile, process.pid.toString(), { mode: 0o600 });
  }

  private removeLockFile(): void {
    const lockFile = getLockFilePath();
    if (existsSync(lockFile)) {
      try {
        rmSync(lockFile);
      } catch {
        // Ignore
      }
    }
  }

  private handleConnection(socket: Socket): void {
    this.clients.add(socket);
    let buffer = "";

    const client: DaemonClient = {
      send: (response: DaemonResponse) => {
        if (!socket.destroyed) {
          socket.write(JSON.stringify(response) + "\n");
        }
      },
      onDisconnect: () => {
        // Cleanup subscriptions
        for (const [event, subs] of this.state.subscribers) {
          subs.delete(client);
          if (subs.size === 0) {
            this.state.subscribers.delete(event);
          }
        }
      },
    };

    socket.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.trim()) {
          this.handleRequest(client, line);
        }
      }
    });

    socket.on("close", () => {
      this.clients.delete(socket);
      client.onDisconnect?.();
    });

    socket.on("error", () => {
      this.clients.delete(socket);
      client.onDisconnect?.();
    });
  }

  private async handleRequest(client: DaemonClient, line: string): Promise<void> {
    try {
      const request = JSON.parse(line) as DaemonRequest & { _reqId?: number };

      // Helper to send response with matching reqId
      const sendResponse = (response: Omit<DaemonResponse, "_reqId">) => {
        const fullResponse = request._reqId !== undefined 
          ? { ...response, _reqId: request._reqId }
          : response;
        client.send(fullResponse as DaemonResponse);
      };

      switch (request.type) {
        case "ping":
          sendResponse({ type: "pong", timestamp: Date.now() });
          break;

        case "getRepos": {
          // Return cached repos immediately - never block on refresh
          // Background polling keeps cache updated via REPO_POLL_INTERVAL_MS
          sendResponse({ type: "repos", repos: this.state.repos });
          break;
        }

        case "getStatus": {
          const status = this.state.statuses.get(request.worktreePath) || null;
          sendResponse({ type: "status", worktreePath: request.worktreePath, status });
          break;
        }

        case "getAllStatuses": {
          const statuses = Array.from(this.state.statuses.entries()).map(
            ([worktreePath, data]) => ({ worktreePath, data })
          );
          sendResponse({ type: "allStatuses", statuses });
          break;
        }

        case "refreshRepos":
          await this.refreshRepos();
          sendResponse({ type: "repos", repos: this.state.repos });
          break;

        case "refreshStatuses":
          await this.refreshStatuses();
          sendResponse({ type: "ok" });
          break;

        case "subscribe": {
          const subs = this.state.subscribers.get(request.event) || new Set();
          subs.add(client);
          this.state.subscribers.set(request.event, subs);
          sendResponse({ type: "ok" });
          break;
        }

        case "unsubscribe": {
          const subs = this.state.subscribers.get(request.event);
          if (subs) {
            subs.delete(client);
            if (subs.size === 0) {
              this.state.subscribers.delete(request.event);
            }
          }
          sendResponse({ type: "ok" });
          break;
        }

        default:
          sendResponse({ type: "error", message: "Unknown request type" });
      }
    } catch (err) {
      sendResponse({ type: "error", message: String(err) });
    }
  }

  private startPolling(): void {
    // Poll for repo changes (less frequent)
    this.repoPollTimer = setInterval(() => {
      this.refreshRepos();
    }, REPO_POLL_INTERVAL_MS);

    // Poll for status changes (more frequent)
    this.statusPollTimer = setInterval(() => {
      this.refreshStatuses();
    }, STATUS_POLL_INTERVAL_MS);
  }

  private async refreshRepos(): Promise<void> {
    try {
      const repos = await discoverRepos(mockPi);
      const hadChanges = JSON.stringify(this.state.repos) !== JSON.stringify(repos);
      
      this.state.repos = repos;
      this.state.reposLastUpdated = Date.now();

      if (hadChanges) {
        this.broadcastEvent("reposChanged", { repos });
      }
    } catch (err) {
      console.error("Failed to refresh repos:", err);
    }
  }

  private async refreshStatuses(): Promise<void> {
    try {
      const prevStatuses = new Map(this.state.statuses);
      const newStatuses = new Map<string, SessionStatusData>();
      let waitingCount = 0;
      const waitingRepos = new Set<string>();

      // Process all worktrees in parallel batches
      const allWorktrees = this.state.repos.flatMap((repo) =>
        repo.worktrees.map((wt) => ({ ...wt, repoName: repo.name }))
      );

      const CONCURRENCY_LIMIT = 20;
      for (let i = 0; i < allWorktrees.length; i += CONCURRENCY_LIMIT) {
        const batch = allWorktrees.slice(i, i + CONCURRENCY_LIMIT);
        await Promise.all(
          batch.map(async (worktree) => {
            try {
              const statusData = await this.statusService.read(worktree.path);
              if (statusData) {
                newStatuses.set(worktree.path, statusData);
                if (statusData.status === "waiting") {
                  waitingCount++;
                  waitingRepos.add(worktree.repoName);
                }
              }
            } catch {
              // Ignore errors for individual worktrees
            }
          })
        );
      }

      // Detect changes
      const changedWorktrees: Array<{
        path: string;
        oldStatus: SessionStatusData | null;
        newStatus: SessionStatusData | null;
      }> = [];

      for (const [path, newStatus] of newStatuses) {
        const oldStatus = prevStatuses.get(path) || null;
        if (JSON.stringify(oldStatus) !== JSON.stringify(newStatus)) {
          changedWorktrees.push({ path, oldStatus, newStatus });
        }
      }

      // Check for waiting count changes BEFORE updating state
      const prevWaitingCount = this.state.waitingCount;
      const prevWaitingRepos = this.state.waitingRepos;
      const waitingReposArray = Array.from(waitingRepos);
      
      const waitingCountChanged = waitingCount !== prevWaitingCount;
      const waitingReposChanged = JSON.stringify(waitingReposArray) !== JSON.stringify(prevWaitingRepos);

      // Update state
      this.state.statuses = newStatuses;
      this.state.waitingCount = waitingCount;
      this.state.waitingRepos = waitingReposArray;

      // Broadcast changes
      if (changedWorktrees.length > 0) {
        for (const change of changedWorktrees) {
          this.broadcastEvent("statusChange", change);
        }
      }

      if (waitingCountChanged || waitingReposChanged) {
        this.broadcastEvent("waitingChange", { 
          waitingCount, 
          waitingRepos: waitingReposArray 
        });
      }
    } catch (err) {
      console.error("Failed to refresh statuses:", err);
    }
  }

  private broadcastEvent(event: string, data: unknown): void {
    const subs = this.state.subscribers.get(event);
    if (subs) {
      for (const client of subs) {
        client.send({ type: "event", event: event as "statusChange" | "waitingChange", data });
      }
    }
  }

  stop(): void {
    console.log("Shutting down daemon...");
    this.cleanup();
    process.exit(0);
  }

  private cleanup(): void {
    if (this.repoPollTimer) {
      clearInterval(this.repoPollTimer);
      this.repoPollTimer = null;
    }
    if (this.statusPollTimer) {
      clearInterval(this.statusPollTimer);
      this.statusPollTimer = null;
    }

    for (const client of this.clients) {
      client.destroy();
    }
    this.clients.clear();

    if (this.server) {
      this.server.close();
      this.server = null;
    }

    const socketPath = getSocketPath();
    if (existsSync(socketPath)) {
      try {
        unlinkSync(socketPath);
      } catch {
        // Ignore
      }
    }

    this.removeLockFile();
  }
}

// Start if run directly (Deno: import.meta.main, Node: PI_WORKTREE_DAEMON env var)
const isMainModule = import.meta.main || process.env.PI_WORKTREE_DAEMON === "1";
if (isMainModule) {
  const daemon = new WorktreeDaemon();
  daemon.start().catch((err) => {
    console.error("Failed to start daemon:", err);
    process.exit(1);
  });
}

export { WorktreeDaemon };
