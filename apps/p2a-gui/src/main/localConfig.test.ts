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
  setUiLocale,
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

  it("limits recent projects to the most recent eight entries", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "p2a-gui-config-"));
    const configPath = configPathForUserData(userDataPath);

    try {
      for (let index = 0; index < 10; index += 1) {
        await rememberRecentProject(configPath, {
          rootPath: `/tmp/project-${index}`,
          name: `project-${index}`,
        });
      }

      const snapshot = await loadGuiConfig(configPath);
      expect(snapshot.recentProjects).toHaveLength(8);
      expect(snapshot.recentProjects.map((project) => project.name)).toEqual([
        "project-9",
        "project-8",
        "project-7",
        "project-6",
        "project-5",
        "project-4",
        "project-3",
        "project-2",
      ]);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("rejects unsupported default agent tools without changing stored settings", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "p2a-gui-config-"));
    const configPath = configPathForUserData(userDataPath);

    try {
      await rememberRecentProject(configPath, {
        rootPath: "/tmp/project-a",
        name: "project-a",
      });
      await setDefaultAgentTool(configPath, "/tmp/project-a", "claude");

      await expect(
        setDefaultAgentTool(configPath, "/tmp/project-a", "unsupported" as never),
      ).rejects.toThrow("Unsupported agent tool");
      expect(await readDefaultAgentTool(configPath, "/tmp/project-a")).toBe("claude");
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("stores the selected UI locale", async () => {
    const userDataPath = await mkdtemp(path.join(tmpdir(), "p2a-gui-config-"));
    const configPath = configPathForUserData(userDataPath);

    try {
      expect((await loadGuiConfig(configPath)).locale).toBe("ko");
      expect((await setUiLocale(configPath, "en")).locale).toBe("en");

      await expect(setUiLocale(configPath, "fr" as never)).rejects.toThrow(
        "Unsupported locale",
      );
      expect((await loadGuiConfig(configPath)).locale).toBe("en");
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });
});
