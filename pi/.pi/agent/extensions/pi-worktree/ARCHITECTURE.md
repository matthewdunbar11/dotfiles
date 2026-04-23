# Proposed Architecture for pi-worktree

## Current Problems
1. **Single 1300+ line file** - Everything crammed together
2. **Mixed concerns** - Git, tmux, status tracking, and UI all intertwined
3. **Deep nesting** - Functions nested inside functions, hard to follow
4. **Duplicate logic** - Status reading implemented in 3+ places
5. **Fragile session mapping** - Complex name derivation, easy to break
6. **No separation** - UI components mixed with business logic

## Proposed Structure

```
src/
├── types.ts          # All interfaces and types
├── utils.ts          # Shared utilities (execCommand, fuzzyFilter)
├── git.ts            # Git operations
├── tmux.ts           # Tmux operations
├── status.ts         # Status tracking service
├── ui/
│   ├── common.ts     # Shared UI helpers
│   ├── repo-picker.ts
│   ├── worktree-picker.ts
│   └── dialogs.ts    # Confirmation, input dialogs
├── commands/
│   ├── worktree.ts   # /wt command
│   └── status.ts     # /wt-status command
└── index.ts          # Extension entry point
```

## Module Responsibilities

### types.ts
- SessionStatus, RepoInfo, WorktreeInfo interfaces
- UI-related types (SelectItem, etc.)

### utils.ts
- execCommand() - Shell execution wrapper
- fuzzyFilter() - Fuzzy search utility
- getSessionName() - Session naming (legacy support)

### git.ts
- discoverRepos() - Find repos in ~/Code
- getWorktrees() - List worktrees for repo
- createWorktree() - Create new worktree+branch
- deleteWorktree() - Remove worktree
- getCurrentWorktreePath() - Get current git root

### tmux.ts
- getTmuxSessions() - List sessions
- getCurrentSession() - Get current session name
- attachToSession() - Switch/create session
- killSession() - Remove session
- setSessionOption() / getSessionOption() - Option management

### status.ts
- StatusService class
  - read(worktreePath) - Get status for worktree
  - write(status) - Write status for current session
  - findSessionByWorktree() - Map worktree to session
  - getRepoStatus() - Rollup status for repo

### ui/*.ts
- Pure UI components using @mariozechner/pi-tui
- No business logic, only presentation
- Return user choices (selections, confirmations)

### commands/*.ts
- Command handlers that orchestrate git/tmux/ui
- Each command is a clear workflow

### index.ts
- Registers commands and event handlers
- Wires up the status service to pi events

## Key Design Decisions

1. **StatusService as central hub** - All status operations go through it
2. **UI returns choices, not actions** - Commands decide what to do with selections
3. **Git/Tmux are pure operations** - They don't know about UI or status
4. **No nested functions** - Flat structure, easy to navigate
5. **Async/await throughout** - No callback hell

## Migration Plan

1. Create directory structure
2. Extract types.ts (no dependencies)
3. Extract utils.ts (depends on types)
4. Extract tmux.ts and git.ts (depend on utils)
5. Extract status.ts (depends on tmux/git)
6. Extract UI components (depend on types)
7. Extract command handlers (depend on everything)
8. Create new index.ts
9. Test and delete old file
