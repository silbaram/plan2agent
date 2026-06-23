const fs = require("node:fs");
const path = require("node:path");

function ensureExecutable(filePath) {
  if (!fs.existsSync(filePath)) return;
  const stats = fs.statSync(filePath);
  if (!stats.isFile()) return;
  fs.chmodSync(filePath, stats.mode | 0o755);
}

function copyModule(buildPath, moduleName) {
  const source = path.join(__dirname, "node_modules", moduleName);
  const target = path.join(buildPath, "node_modules", moduleName);
  if (!fs.existsSync(source)) {
    throw new Error(`${moduleName} is missing from local node_modules: ${source}`);
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(source, target, { recursive: true });
  return target;
}

function copyNodePty(buildPath) {
  copyModule(buildPath, "node-addon-api");
  const target = copyModule(buildPath, "node-pty");
  ensureExecutable(path.join(target, "prebuilds", "darwin-arm64", "spawn-helper"));
  ensureExecutable(path.join(target, "prebuilds", "darwin-x64", "spawn-helper"));
  ensureExecutable(path.join(target, "build", "Release", "spawn-helper"));
}

module.exports = {
  packagerConfig: {
    asar: {
      unpack: "**/node_modules/node-pty/{build,prebuilds}/**",
    },
    executableName: "p2a-gui",
    name: "P2A GUI",
  },
  rebuildConfig: {},
  makers: [],
  hooks: {
    packageAfterCopy: async (_forgeConfig, buildPath) => {
      copyNodePty(buildPath);
    },
  },
  plugins: [
    {
      name: "@electron-forge/plugin-vite",
      config: {
        build: [
          {
            entry: "src/main/main.ts",
            config: "vite.main.config.mjs",
          },
          {
            entry: "src/preload/preload.ts",
            config: "vite.preload.config.mjs",
          },
        ],
        renderer: [
          {
            name: "main_window",
            config: "vite.renderer.config.mjs",
          },
        ],
      },
    },
  ],
};
