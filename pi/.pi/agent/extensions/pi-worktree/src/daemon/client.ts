/**
 * Client for communicating with pi-worktree daemon
 */

import { createConnection, type Socket } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { RepoInfo, SessionStatusData } from "../types.ts";
import {
  type DaemonRequest,
  type DaemonResponse,
  getSocketPath,
} from "./protocol.ts";

export type StatusChangeHandler = (
  worktreePath: string,
  oldStatus: SessionStatusData | null,
  newStatus: SessionStatusData | null
) => void;

export type WaitingChangeHandler = (waitingCount: number, waitingRepos: string[]) => void;

export class WorktreeDaemonClient {
  private socket: Socket | null = null;
  private pendingRequests = new Map<
    number,
    { resolve: (value: DaemonResponse) => void; reject: (err: Error) => void; timeout: NodeJS.Timeout }
  >();
  private requestId = 0;
  private buffer = "";
  private eventHandlers = {
    statusChange: new Set<StatusChangeHandler>(),
    waitingChange: new Set<WaitingChangeHandler>(),
  };
  private daemonProcess: ChildProcess | null = null;

  async connect(): Promise<void> {
    // Try existing daemon first
    if (await this.tryConnect()) return;

    // Start daemon
    try {
      await this.startDaemon();
    } catch (err) {
      console.error("[pi-worktree] Failed to start daemon:", err);
      throw err;
    }

    // Wait for daemon to create socket file (initial scan takes ~2s)
    const socketPath = getSocketPath();
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (existsSync(socketPath)) {
        // Socket file exists, try to connect
        if (await this.tryConnect()) return;
      }
    }

    throw new Error("Daemon failed to create socket");
  }

  private async tryConnect(): Promise<boolean> {
    const socketPath = getSocketPath();
    if (!existsSync(socketPath)) return false;

    return new Promise((resolve) => {
      const socket = createConnection(socketPath, () => {
        this.socket = socket;
        resolve(true);
      });

      socket.on("data", (data) => this.handleData(data.toString()));
      socket.on("close", () => { this.socket = null; });
      socket.on("error", () => { 
        this.socket = null; 
        resolve(false); 
      });

      // Timeout after 1s
      setTimeout(() => {
        if (!this.socket) {
          socket.destroy();
          resolve(false);
        }
      }, 1000);
    });
  }

  private async startDaemon(): Promise<void> {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const daemonPath = join(__dirname, "daemon.ts");

    return new Promise((resolve, reject) => {
      let spawnCmd: string;
      let spawnArgs: string[];
      let spawnEnv = { ...process.env, PI_WORKTREE_DAEMON: "1" };

      // Detect runtime and set appropriate spawn args
      if (process.versions.deno) {
        spawnCmd = process.execPath;
        spawnArgs = ["run", "--allow-all", daemonPath];
      } else if (process.versions.bun) {
        spawnCmd = process.execPath;
        spawnArgs = ["run", daemonPath];
      } else {
        // Node.js - use local tsx from extension's node_modules
        spawnCmd = process.execPath;
        const extensionRoot = join(__dirname, "..", "..");
        const tsxPath = join(extensionRoot, "node_modules", "tsx", "dist", "loader.mjs");
        spawnArgs = ["--import", tsxPath, daemonPath];
      }

      let resolved = false;

      this.daemonProcess = spawn(spawnCmd, spawnArgs, {
        detached: true,
        stdio: ["ignore", "inherit", "inherit"], // stdout/stderr to parent so we can see daemon logs
        env: spawnEnv,
      });

      this.daemonProcess.on("error", (err) => {
        if (!resolved) {
          resolved = true;
          reject(new Error(`Failed to spawn daemon: ${err.message}`));
        }
      });

      this.daemonProcess.on("exit", (code) => {
        if (!resolved && code !== 0 && code !== null) {
          resolved = true;
          reject(new Error(`Daemon exited with code ${code}`));
        }
      });

      // Give daemon time to start and create socket
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      }, 800);
    });
  }

  private handleData(data: string): void {
    this.buffer += data;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const response = JSON.parse(line) as DaemonResponse & { _reqId?: number };
        
        if (response.type === "event") {
          this.handleEvent(response);
        } else if (response._reqId && this.pendingRequests.has(response._reqId)) {
          const { resolve, timeout } = this.pendingRequests.get(response._reqId)!;
          clearTimeout(timeout);
          this.pendingRequests.delete(response._reqId);
          resolve(response);
        }
      } catch {
        // Ignore malformed
      }
    }
  }

  private handleEvent(response: DaemonResponse & { event?: string; data?: unknown }): void {
    if (response.event === "statusChange") {
      const data = response.data as { path: string; oldStatus: SessionStatusData | null; newStatus: SessionStatusData | null };
      for (const handler of this.eventHandlers.statusChange) {
        handler(data.path, data.oldStatus, data.newStatus);
      }
    } else if (response.event === "waitingChange") {
      const data = response.data as { waitingCount: number; waitingRepos: string[] };
      for (const handler of this.eventHandlers.waitingChange) {
        handler(data.waitingCount, data.waitingRepos);
      }
    }
  }

  private async sendRequest(request: DaemonRequest): Promise<DaemonResponse> {
    if (!this.socket) throw new Error("Not connected to daemon");

    const reqId = ++this.requestId;
    const requestWithId = { ...request, _reqId: reqId };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(reqId);
        reject(new Error("Request timeout"));
      }, 30000);

      this.pendingRequests.set(reqId, { resolve, reject, timeout });
      this.socket!.write(JSON.stringify(requestWithId) + "\n");
    });
  }

  // Public API
  async getRepos(): Promise<RepoInfo[]> {
    const resp = await this.sendRequest({ type: "getRepos" });
    if (resp.type === "repos") return resp.repos;
    throw new Error("Failed to get repos");
  }

  async getStatus(worktreePath: string): Promise<SessionStatusData | null> {
    const resp = await this.sendRequest({ type: "getStatus", worktreePath });
    if (resp.type === "status") return resp.status;
    throw new Error("Failed to get status");
  }

  async getAllStatuses(): Promise<Array<{ worktreePath: string; data: SessionStatusData }>> {
    const resp = await this.sendRequest({ type: "getAllStatuses" });
    if (resp.type === "allStatuses") return resp.statuses;
    throw new Error("Failed to get statuses");
  }

  async refreshRepos(): Promise<RepoInfo[]> {
    const resp = await this.sendRequest({ type: "refreshRepos" });
    if (resp.type === "repos") return resp.repos;
    throw new Error("Failed to refresh repos");
  }

  onWaitingChange(handler: WaitingChangeHandler): void {
    this.eventHandlers.waitingChange.add(handler);
    this.sendRequest({ type: "subscribe", event: "waitingChange" }).catch(() => {});
  }

  offWaitingChange(handler: WaitingChangeHandler): void {
    this.eventHandlers.waitingChange.delete(handler);
    if (this.eventHandlers.waitingChange.size === 0) {
      this.sendRequest({ type: "unsubscribe", event: "waitingChange" }).catch(() => {});
    }
  }
}

let globalClient: WorktreeDaemonClient | null = null;

export function getGlobalClient(): WorktreeDaemonClient {
  if (!globalClient) globalClient = new WorktreeDaemonClient();
  return globalClient;
}
