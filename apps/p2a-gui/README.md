# P2A GUI

Electron MVP for the Plan2Agent supervised desktop GUI.

## Scope

- Electron main process owns app lifecycle, native dialogs, project file loading, file watching, command execution, and PTY lifecycle.
- Preload exposes a narrow typed API through `contextBridge`.
- Renderer is a React workbench for Overview, Tasks, Runs, Terminal, and Settings.
- Project artifacts and runs remain file-based. The GUI reads existing P2A files and calls the existing `scripts/p2a_execute.mjs` lifecycle for start/finish actions.
- Terminal sessions use `node-pty` and `xterm.js` for a single supervised agent CLI session.
- The GUI does not scaffold, import, upgrade, repair, or overwrite P2A harness files. Those actions are shown as command guidance only.

## Commands

```bash
cd apps/p2a-gui
npm install
npm run typecheck
npm test
npm start
```

Package a local desktop build:

```bash
cd apps/p2a-gui
npm run package
```

Run a packaged app smoke test:

```bash
cd apps/p2a-gui
npm run smoke:packaged
```

The packaged smoke command builds the app, launches the packaged Electron executable with an isolated GUI config directory, opens a temporary P2A project from the recent-project list, starts a run, finishes it with a custom verification command, and checks the resulting task/run files. Use `npm run smoke:packaged -- --skip-package` to reuse an existing package, or add `-- --keep-temp` to inspect the temporary project after the run.

## Use

1. Start the app with `npm start`.
2. Open a project folder that contains P2A artifacts or a P2A harness.
3. Use Overview to confirm detection state, active artifact root, gates, and readiness.
4. Use Tasks to inspect ready tasks and start a run.
5. Use Terminal to start a supervised agent CLI session, send messages, stop, or kill the session.
6. Use Runs to inspect run history and finish a selected run with verification, changed files, and notes.

Agent CLIs such as `codex`, `claude`, `gemini`, `aider`, or `cursor` must already be installed and available on `PATH`. The GUI records the selected tool in the run lifecycle, but it does not install provider CLIs.

## Verification

The main regression suite runs with:

```bash
cd apps/p2a-gui
npm test
```

The tests cover project loading, local config, terminal command helpers, execution command construction, and an automated smoke path that creates a temporary P2A project, runs `startRun`, runs `finishRun`, and reloads the project snapshot. Failure paths cover missing `p2a_execute`, not-ready task start, and verification failure recording.

The packaged smoke test uses `P2A_GUI_USER_DATA_DIR` to isolate recent-project config from the developer's normal app data.

## MVP limitations

- One active PTY session at a time.
- No parallel task execution.
- No raw PTY transcript persistence by default.
- No PR creation, merge automation, scheduler, or multi-agent orchestration.
- No GUI-driven harness installation, import, upgrade, or repair.
