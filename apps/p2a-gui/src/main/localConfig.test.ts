import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  configPathForUserData,
  forgetRecentProject,
  loadGuiConfig,
  readDefaultAgentTool,
  rememberRecentProject,
  setDefaultAgentTool,
} from "./localConfig";

describe("local GUI config", () => {
  it("stores recent projects and project-level default agent tools", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "p2a-gui-config-"));
    const configPath = configPathForUserData(userDataPath);

    try {
      await rememberRecentProject(configPath, {
        rootPath: "/tmp/project-a",
        name: "project-a",
      });
      await rememberRecentProject(configPath, {
        rootPath: "/tmp/project-b",
        name: "project-b",
      });
      await setDefaultAgentTool(configPath, "/tmp/project-a", "claude");

      const snapshot = await loadGuiConfig(configPath);
      expect(snapshot.recentProjects.map((project) => project.name)).toEqual([
        "project-b",
        "project-a",
      ]);
      expect(await readDefaultAgentTool(configPath, "/tmp/project-a")).toBe("claude");
      expect(snapshot.recentProjects[1]?.defaultAgentTool).toBe("claude");
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("forgets a recent project and its project settings", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "p2a-gui-config-"));
    const configPath = configPathForUserData(userDataPath);

    try {
      await rememberRecentProject(configPath, {
        rootPath: "/tmp/project-a",
        name: "project-a",
      });
      await setDefaultAgentTool(configPath, "/tmp/project-a", "claude");
      const snapshot = await forgetRecentProject(configPath, "/tmp/project-a");

      expect(snapshot.recentProjects).toHaveLength(0);
      expect(await readDefaultAgentTool(configPath, "/tmp/project-a")).toBe("codex");
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });
});
