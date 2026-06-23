#!/usr/bin/env node
import { chmodSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helperPaths = [
  path.join(appRoot, "node_modules", "node-pty", "prebuilds", "darwin-arm64", "spawn-helper"),
  path.join(appRoot, "node_modules", "node-pty", "prebuilds", "darwin-x64", "spawn-helper"),
  path.join(appRoot, "node_modules", "node-pty", "build", "Release", "spawn-helper"),
];

let updated = 0;

for (const helperPath of helperPaths) {
  if (!existsSync(helperPath)) continue;
  const stats = statSync(helperPath);
  if (!stats.isFile()) continue;

  const nextMode = stats.mode | 0o755;
  if ((stats.mode & 0o111) === 0o111) continue;
  chmodSync(helperPath, nextMode);
  updated += 1;
  console.log(`made node-pty spawn-helper executable: ${path.relative(appRoot, helperPath)}`);
}

if (updated === 0) {
  console.log("node-pty spawn-helper executable mode already valid or not present");
}
