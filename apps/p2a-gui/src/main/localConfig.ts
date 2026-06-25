import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_EXECUTION_AGENT_TOOL,
  DEFAULT_UI_LOCALE,
  EXECUTION_AGENT_TOOLS,
  UI_LOCALES,
  type ExecutionAgentTool,
  type GuiConfigSnapshot,
  type RecentProject,
  type UiLocale,
} from "../shared/ipc";

const GUI_CONFIG_SCHEMA_VERSION = "p2a.gui_config.v1" as const;
const GUI_CONFIG_FILE = "p2a-gui-config.json";
const MAX_RECENT_PROJECTS = 8;

type ProjectSetting = {
  defaultAgentTool: ExecutionAgentTool;
};

type GuiConfigFile = {
  schemaVersion: typeof GUI_CONFIG_SCHEMA_VERSION;
  locale: UiLocale;
  recentProjects: Array<{
    rootPath: string;
    name: string;
    lastOpenedAt: string;
  }>;
  projectSettings: Record<string, ProjectSetting>;
};

function defaultConfig(): GuiConfigFile {
  return {
    schemaVersion: GUI_CONFIG_SCHEMA_VERSION,
    locale: DEFAULT_UI_LOCALE,
    recentProjects: [],
    projectSettings: {},
  };
}

export function configPathForUserData(userDataPath: string): string {
  return path.join(userDataPath, GUI_CONFIG_FILE);
}

function isExecutionAgentTool(value: unknown): value is ExecutionAgentTool {
  return typeof value === "string" && EXECUTION_AGENT_TOOLS.includes(value as ExecutionAgentTool);
}

function isUiLocale(value: unknown): value is UiLocale {
  return typeof value === "string" && UI_LOCALES.includes(value as UiLocale);
}

function normalizeConfig(parsed: unknown): GuiConfigFile {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return defaultConfig();
  }

  const raw = parsed as Partial<GuiConfigFile>;
  const projectSettings: Record<string, ProjectSetting> = {};
  if (raw.projectSettings && typeof raw.projectSettings === "object") {
    for (const [rootPath, setting] of Object.entries(raw.projectSettings)) {
      if (!setting || typeof setting !== "object") continue;
      const defaultAgentTool = (setting as Partial<ProjectSetting>).defaultAgentTool;
      projectSettings[rootPath] = {
        defaultAgentTool: isExecutionAgentTool(defaultAgentTool)
          ? defaultAgentTool
          : DEFAULT_EXECUTION_AGENT_TOOL,
      };
    }
  }

  const recentProjects = Array.isArray(raw.recentProjects)
    ? raw.recentProjects
        .filter((project) => {
          return Boolean(
            project &&
              typeof project.rootPath === "string" &&
              typeof project.name === "string" &&
              typeof project.lastOpenedAt === "string",
          );
        })
        .slice(0, MAX_RECENT_PROJECTS)
    : [];

  return {
    schemaVersion: GUI_CONFIG_SCHEMA_VERSION,
    locale: isUiLocale(raw.locale) ? raw.locale : DEFAULT_UI_LOCALE,
    recentProjects,
    projectSettings,
  };
}

async function readConfig(configPath: string): Promise<GuiConfigFile> {
  try {
    const raw = await readFile(configPath, "utf8");
    return normalizeConfig(JSON.parse(raw));
  } catch {
    return defaultConfig();
  }
}

async function writeConfig(configPath: string, config: GuiConfigFile): Promise<void> {
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(`${configPath}.tmp`, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await rename(`${configPath}.tmp`, configPath);
}

function toSnapshot(configPath: string, config: GuiConfigFile): GuiConfigSnapshot {
  return {
    schemaVersion: GUI_CONFIG_SCHEMA_VERSION,
    configPath,
    locale: config.locale,
    recentProjects: config.recentProjects.map((project): RecentProject => ({
      ...project,
      defaultAgentTool:
        config.projectSettings[project.rootPath]?.defaultAgentTool ?? DEFAULT_EXECUTION_AGENT_TOOL,
    })),
  };
}

export async function loadGuiConfig(configPath: string): Promise<GuiConfigSnapshot> {
  return toSnapshot(configPath, await readConfig(configPath));
}

export async function setUiLocale(
  configPath: string,
  locale: UiLocale,
): Promise<GuiConfigSnapshot> {
  if (!isUiLocale(locale)) {
    throw new Error(`Unsupported locale: ${String(locale)}`);
  }
  const config = await readConfig(configPath);
  config.locale = locale;
  await writeConfig(configPath, config);
  return toSnapshot(configPath, config);
}

export async function rememberRecentProject(
  configPath: string,
  project: { rootPath: string; name: string },
): Promise<GuiConfigSnapshot> {
  const config = await readConfig(configPath);
  const normalizedRootPath = path.resolve(project.rootPath);
  const remaining = config.recentProjects.filter(
    (recentProject) => path.resolve(recentProject.rootPath) !== normalizedRootPath,
  );

  config.recentProjects = [
    {
      rootPath: normalizedRootPath,
      name: project.name,
      lastOpenedAt: new Date().toISOString(),
    },
    ...remaining,
  ].slice(0, MAX_RECENT_PROJECTS);
  config.projectSettings[normalizedRootPath] ??= {
    defaultAgentTool: DEFAULT_EXECUTION_AGENT_TOOL,
  };

  await writeConfig(configPath, config);
  return toSnapshot(configPath, config);
}

export async function forgetRecentProject(
  configPath: string,
  rootPath: string,
): Promise<GuiConfigSnapshot> {
  const config = await readConfig(configPath);
  const normalizedRootPath = path.resolve(rootPath);
  config.recentProjects = config.recentProjects.filter(
    (project) => path.resolve(project.rootPath) !== normalizedRootPath,
  );
  delete config.projectSettings[normalizedRootPath];
  await writeConfig(configPath, config);
  return toSnapshot(configPath, config);
}

export async function readDefaultAgentTool(
  configPath: string,
  rootPath: string,
): Promise<ExecutionAgentTool> {
  const config = await readConfig(configPath);
  return config.projectSettings[path.resolve(rootPath)]?.defaultAgentTool ?? DEFAULT_EXECUTION_AGENT_TOOL;
}

export async function setDefaultAgentTool(
  configPath: string,
  rootPath: string,
  agentTool: ExecutionAgentTool,
): Promise<GuiConfigSnapshot> {
  if (!isExecutionAgentTool(agentTool)) {
    throw new Error(`Unsupported agent tool: ${String(agentTool)}`);
  }
  const config = await readConfig(configPath);
  const normalizedRootPath = path.resolve(rootPath);
  config.projectSettings[normalizedRootPath] = { defaultAgentTool: agentTool };
  await writeConfig(configPath, config);
  return toSnapshot(configPath, config);
}
