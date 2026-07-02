import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildOperationalActionCommand,
  runOperationalAction,
} from "./operationalActions";

async function createProject() {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "p2a-operational-"));
  const scriptsDir = path.join(projectRoot, ".plan2agent", "scripts");
  const artifactRoot = path.join(projectRoot, ".plan2agent", "artifacts", "demo");
  await mkdir(scriptsDir, { recursive: true });
  await mkdir(artifactRoot, { recursive: true });
  await writeFile(
    path.join(scriptsDir, "p2a.mjs"),
    "console.log(JSON.stringify(process.argv.slice(2)))\n",
  );
  return { projectRoot, artifactRoot };
}

describe("operational actions", () => {
  it("builds update preview and apply commands through p2a.mjs", async () => {
    const { projectRoot, artifactRoot } = await createProject();
    try {
      expect(
        buildOperationalActionCommand({
          projectRoot,
          artifactRoot,
          action: "update_preview",
        }),
      ).toMatchObject({
        cwd: projectRoot,
        args: ["update", "--dry-run"],
        displayCommand: "node .plan2agent/scripts/p2a.mjs update --dry-run",
      });

      expect(
        buildOperationalActionCommand({
          projectRoot,
          artifactRoot,
          action: "update_apply",
        }).displayCommand,
      ).toBe("node .plan2agent/scripts/p2a.mjs update --apply");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("builds eval generate, analyze, and digest commands for the active artifact", async () => {
    const { projectRoot, artifactRoot } = await createProject();
    try {
      expect(
        buildOperationalActionCommand({
          projectRoot,
          artifactRoot,
          action: "eval_generate",
        }),
      ).toMatchObject({
        args: [
          "eval",
          "generate",
          "--artifacts",
          ".plan2agent/artifacts/demo",
        ],
        displayCommand:
          "node .plan2agent/scripts/p2a.mjs eval generate --artifacts .plan2agent/artifacts/demo",
      });

      expect(
        buildOperationalActionCommand({
          projectRoot,
          artifactRoot,
          action: "eval_analyze",
        }).args,
      ).toEqual([
        "eval",
        "analyze",
        "--artifacts",
        ".plan2agent/artifacts/demo",
        "--output",
        ".plan2agent/artifacts/demo/eval/analysis.json",
      ]);

      expect(
        buildOperationalActionCommand({
          projectRoot,
          artifactRoot,
          action: "eval_digest",
        }).args,
      ).toEqual([
        "eval",
        "digest",
        "--eval",
        ".plan2agent/artifacts/demo/eval",
        "--output",
        ".plan2agent/artifacts/demo/eval/eval-digest.json",
      ]);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("rejects eval actions without an artifact root inside the project", async () => {
    const { projectRoot } = await createProject();
    try {
      expect(() =>
        buildOperationalActionCommand({
          projectRoot,
          artifactRoot: null,
          action: "eval_generate",
        }),
      ).toThrow("artifact root is required");

      expect(() =>
        buildOperationalActionCommand({
          projectRoot,
          artifactRoot: "/tmp/outside-artifact",
          action: "eval_digest",
        }),
      ).toThrow("artifact root must stay inside project root");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("runs an operational action and captures command output", async () => {
    const { projectRoot } = await createProject();
    try {
      const result = await runOperationalAction({
        projectRoot,
        action: "update_preview",
      });

      expect(result.exitCode).toBe(0);
      expect(result.command).toBe("node .plan2agent/scripts/p2a.mjs update --dry-run");
      expect(result.stdout).toContain("[\"update\",\"--dry-run\"]");
      expect(result.followUpCommands).toEqual([]);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
