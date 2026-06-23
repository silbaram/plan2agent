# P2A GUI

Electron MVP skeleton for the Plan2Agent supervised desktop GUI.

## Scope

- Electron main process owns app lifecycle, native dialogs, future file access, and future PTY process lifecycle.
- Preload exposes a narrow typed API through `contextBridge`.
- Renderer is a React workbench shell that will absorb the static prototype screen by screen.
- No project files are modified in this skeleton.
- `node-pty` is installed early to validate native-module rebuild risk.

## Commands

```bash
npm install
npm run typecheck
npm start
```

The first functional milestone after this skeleton is the read-only project loader.
