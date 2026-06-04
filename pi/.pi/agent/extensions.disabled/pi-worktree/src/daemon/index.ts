/**
 * pi-worktree daemon client and protocol exports
 */

export {
  WorktreeDaemonClient,
  getGlobalClient,
  disconnectGlobalClient,
  type StatusChangeHandler,
  type WaitingChangeHandler,
} from "./client.ts";

export {
  type DaemonRequest,
  type DaemonResponse,
  type DaemonState,
  type DaemonClient,
  getSocketPath,
  getLockFilePath,
} from "./protocol.ts";

// Re-export WorktreeDaemon class for programmatic use
export { WorktreeDaemon } from "./daemon.ts";
