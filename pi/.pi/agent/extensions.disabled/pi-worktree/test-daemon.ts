#!/usr/bin/env tsx
/**
 * Test script to debug daemon communication
 * Run with: npx tsx test-daemon.ts
 */

import { createConnection } from "node:net";
import { spawn } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Import getSocketPath to get the correct socket path
const { getSocketPath } = await import("./src/daemon/protocol.ts");
const SOCKET_PATH = getSocketPath();

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function cleanup(): Promise<void> {
  try {
    if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);
  } catch {}
}

async function startDaemon(): Promise<any> {
  const daemonPath = join(__dirname, "src", "daemon", "daemon.ts");
  const tsxPath = join(__dirname, "node_modules", "tsx", "dist", "loader.mjs");
  
  console.log("Starting daemon...");
  console.log(`  Daemon: ${daemonPath}`);
  console.log(`  Socket: ${SOCKET_PATH}`);
  
  const proc = spawn(process.execPath, ["--import", tsxPath, daemonPath], {
    env: { ...process.env, PI_WORKTREE_DAEMON: "1" },
    detached: true,
    stdio: "inherit",
  });
  
  return proc;
}

async function testConnection(): Promise<boolean> {
  console.log("\n1. Testing socket connection...");
  
  if (!existsSync(SOCKET_PATH)) {
    console.error("  FAIL: Socket file does not exist");
    return false;
  }
  console.log("  Socket file exists");
  
  return new Promise((resolve) => {
    const socket = createConnection(SOCKET_PATH, () => {
      console.log("  Connected to daemon");
      socket.end();
      resolve(true);
    });
    
    socket.on("error", (err) => {
      console.error(`  FAIL: Connection error: ${err.message}`);
      resolve(false);
    });
    
    setTimeout(() => {
      console.error("  FAIL: Connection timeout");
      resolve(false);
    }, 2000);
  });
}

async function testPing(): Promise<boolean> {
  console.log("\n2. Testing ping request...");
  
  return new Promise((resolve) => {
    let buffer = "";
    const socket = createConnection(SOCKET_PATH, () => {
      console.log("  Sending ping...");
      socket.write(JSON.stringify({ type: "ping", _reqId: 1 }) + "\n");
    });
    
    socket.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const resp = JSON.parse(line);
          console.log(`  Received: ${JSON.stringify(resp)}`);
          if (resp.type === "pong") {
            console.log("  PASS: Got pong response");
            socket.end();
            resolve(true);
            return;
          }
        } catch {
          console.error(`  Invalid JSON: ${line}`);
        }
      }
    });
    
    socket.on("error", (err) => {
      console.error(`  FAIL: ${err.message}`);
      resolve(false);
    });
    
    setTimeout(() => {
      console.error("  FAIL: Request timeout");
      socket.destroy();
      resolve(false);
    }, 5000);
  });
}

async function testGetRepos(): Promise<boolean> {
  console.log("\n3. Testing getRepos request...");
  
  return new Promise((resolve) => {
    let buffer = "";
    const startTime = Date.now();
    
    const socket = createConnection(SOCKET_PATH, () => {
      console.log("  Sending getRepos...");
      socket.write(JSON.stringify({ type: "getRepos", _reqId: 2 }) + "\n");
    });
    
    socket.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const resp = JSON.parse(line);
          const elapsed = Date.now() - startTime;
          
          if (resp.type === "repos") {
            console.log(`  Received repos response in ${elapsed}ms`);
            console.log(`  Repo count: ${resp.repos?.length || 0}`);
            if (resp.repos?.length > 0) {
              console.log(`  First repo: ${resp.repos[0].name}`);
            }
            console.log("  PASS: Got repos response");
            socket.end();
            resolve(true);
            return;
          }
        } catch (e) {
          console.error(`  Parse error: ${e}`);
        }
      }
    });
    
    socket.on("error", (err) => {
      console.error(`  FAIL: ${err.message}`);
      resolve(false);
    });
    
    setTimeout(() => {
      const elapsed = Date.now() - startTime;
      console.error(`  FAIL: Request timeout after ${elapsed}ms`);
      socket.destroy();
      resolve(false);
    }, 35000);
  });
}

async function main() {
  console.log("=== Daemon Communication Test ===\n");
  
  // Cleanup
  await cleanup();
  
  // Start daemon
  const daemon = await startDaemon();
  
  // Wait for daemon to create socket
  console.log("\nWaiting for daemon to start...");
  for (let i = 0; i < 50; i++) {
    await sleep(100);
    if (existsSync(SOCKET_PATH)) {
      console.log("Socket file created");
      break;
    }
  }
  
  if (!existsSync(SOCKET_PATH)) {
    console.error("Daemon failed to create socket");
    process.exit(1);
  }
  
  // Run tests
  const results = {
    connection: await testConnection(),
    ping: await testPing(),
    getRepos: await testGetRepos(),
  };
  
  console.log("\n=== Results ===");
  console.log(`Connection: ${results.connection ? "PASS" : "FAIL"}`);
  console.log(`Ping:       ${results.ping ? "PASS" : "FAIL"}`);
  console.log(`GetRepos:   ${results.getRepos ? "PASS" : "FAIL"}`);
  
  // Cleanup
  daemon.kill();
  await cleanup();
  
  process.exit(results.getRepos ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
