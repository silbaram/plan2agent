#!/usr/bin/env node
import { constants as fsConstants } from "node:fs";
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(appRoot, "../..");
const outRoot = path.join(appRoot, "out");
const skipPackage = process.argv.includes("--skip-package");
const keepTemp = process.argv.includes("--keep-temp");
const projectName = "gui-smoke-project";
const customVerificationCommand = "node -e \"console.log('packaged smoke verification')\"";

function formatJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      env: {
        ...process.env,
        NO_COLOR: process.env.NO_COLOR ?? "1",
      },
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (exitCode === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${exitCode}`));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function packagedExecutablePath() {
  const arch = process.arch;
  const packageRoot = path.join(outRoot, `P2A GUI-${process.platform}-${arch}`);
  if (process.platform === "darwin") {
    return path.join(packageRoot, "P2A GUI.app", "Contents", "MacOS", "p2a-gui");
  }
  if (process.platform === "win32") {
    return path.join(packageRoot, "p2a-gui.exe");
  }
  return path.join(packageRoot, "p2a-gui");
}

async function assertExecutable(filePath) {
  try {
    await access(filePath, fsConstants.F_OK);
  } catch {
    throw new Error(`Packaged app executable was not found: ${filePath}`);
  }
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function createSmokeProject(tempRoot) {
  const projectRoot = path.join(tempRoot, projectName);
  const taskGraphPath = path.join(projectRoot, "gate-c-task-graph", "task-graph.json");

  await mkdir(projectRoot, { recursive: true });
  await cp(path.join(repoRoot, "scripts"), path.join(projectRoot, "scripts"), {
    recursive: true,
  });
  await cp(path.join(repoRoot, "schemas"), path.join(projectRoot, "schemas"), {
    recursive: true,
  });
  await mkdir(path.join(projectRoot, ".plan2agent"), { recursive: true });
  await mkdir(path.join(projectRoot, "gate-b-spec"), { recursive: true });
  await mkdir(path.dirname(taskGraphPath), { recursive: true });

  await writeFile(
    path.join(projectRoot, ".plan2agent", "manifest.json"),
    formatJson({ schema_version: "p2a.manifest.v1" }),
  );
  await writeFile(
    path.join(projectRoot, "gate-b-spec", "spec.json"),
    formatJson({
      schema_version: "p2a.spec.v1",
      project_id: projectName,
      source_intake: "USER-001",
      product: {
        problem: "Exercise the packaged GUI execution lifecycle.",
        target_users: ["P2A operator"],
        goals: ["Start and finish one task from the packaged app."],
        non_goals: ["Full agent orchestration"],
        core_flows: ["Open recent project, start run, finish run."],
        screens_or_interfaces: ["Task execution workbench"],
        data_model_draft: ["Run record"],
        external_integrations: ["None"],
        success_criteria: ["The task and run files reach a finished state."],
        constraints: ["Use the existing file-based lifecycle."],
      },
      implementation: {
        architecture: ["Electron main process calls the existing CLI scripts."],
        interfaces: ["Typed IPC execution actions"],
        data_flow: ["Task graph to run record to project snapshot"],
        dependencies: ["None"],
        edge_cases: ["CLI command failures"],
        verification: ["Run a custom verification command."],
      },
      clarifying_question_disposition: [],
      open_decisions: [],
      approval: "approved",
      evidence: [
        {
          source_id: "USER-001",
          title: "Packaged GUI smoke test scope",
          url: "",
          used_for: "Regression coverage",
        },
      ],
    }),
  );
  await writeFile(
    taskGraphPath,
    formatJson({
      schema_version: "p2a.task_graph.v1",
      projectId: projectName,
      version: "1",
      sourceSpec: "gate-b-spec/spec.json",
      tasks: [
        {
          id: "task-001",
          title: "Packaged app smoke task",
          description: "A minimal task used to verify the packaged GUI lifecycle.",
          status: "todo",
          dependencies: [],
          acceptanceCriteria: ["The packaged app can start and finish the task."],
          targetArea: "packaged-smoke",
          suggestedAgentPrompt: "Implement the packaged GUI smoke task.",
          sourceSpecRefs: ["product.problem"],
        },
      ],
    }),
  );

  return { projectRoot, taskGraphPath };
}

async function seedGuiConfig(userDataRoot, projectRoot) {
  await mkdir(userDataRoot, { recursive: true });
  await writeFile(
    path.join(userDataRoot, "p2a-gui-config.json"),
    formatJson({
      schemaVersion: "p2a.gui_config.v1",
      recentProjects: [
        {
          rootPath: projectRoot,
          name: projectName,
          lastOpenedAt: new Date().toISOString(),
        },
      ],
      projectSettings: {
        [projectRoot]: {
          defaultAgentTool: "codex",
        },
      },
    }),
  );
}

async function uncheckIfChecked(locator) {
  await locator.waitFor({ state: "visible", timeout: 15_000 });
  if (await locator.isChecked()) {
    await locator.uncheck();
  }
}

async function assertInputValue(locator, expected, label) {
  await locator.waitFor({ state: "visible", timeout: 15_000 });
  const actual = await locator.inputValue();
  if (actual !== expected) {
    throw new Error(`Expected ${label} to be ${expected}, got ${actual}`);
  }
}

async function waitForCdp(port, appOutput, timeoutMs = 30_000) {
  const startedAt = Date.now();
  const endpoint = `http://127.0.0.1:${port}/json/version`;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(endpoint);
      if (response.ok) return;
    } catch {
      // Keep polling until Electron exposes the debugging endpoint.
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for packaged app CDP on port ${port}\n${appOutput.tail()}`);
}

async function waitForAppPage(browser, timeoutMs = 30_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    for (const context of browser.contexts()) {
      const candidate = context
        .pages()
        .find((page) => !page.url().startsWith("devtools://"));
      if (candidate) return candidate;
    }
    await sleep(250);
  }
  throw new Error("Timed out waiting for packaged app window");
}

function createOutputBuffer() {
  let output = "";
  return {
    append(chunk) {
      output += chunk.toString("utf8");
      if (output.length > 12_000) output = output.slice(-12_000);
    },
    tail() {
      return output.trim() ? `App output:\n${output}` : "App output: <empty>";
    },
  };
}

function launchPackagedApp(executablePath, userDataRoot) {
  const remoteDebuggingPort = 29_000 + (process.pid % 1_000);
  const appOutput = createOutputBuffer();
  const child = spawn(executablePath, [], {
    env: {
      ...process.env,
      P2A_GUI_USER_DATA_DIR: userDataRoot,
      P2A_GUI_REMOTE_DEBUGGING_PORT: String(remoteDebuggingPort),
      ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
      NO_COLOR: process.env.NO_COLOR ?? "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => appOutput.append(chunk));
  child.stderr.on("data", (chunk) => appOutput.append(chunk));
  return { child, remoteDebuggingPort, appOutput };
}

async function closePackagedApp(browser, child) {
  await browser?.close().catch(() => {});
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await sleep(1_500);
  }
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await sleep(500);
  }
}

async function runUiSmoke({ executablePath, projectRoot, userDataRoot }) {
  const { child, remoteDebuggingPort, appOutput } = launchPackagedApp(
    executablePath,
    userDataRoot,
  );
  let browser = null;
  let page = null;

  try {
    await waitForCdp(remoteDebuggingPort, appOutput);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${remoteDebuggingPort}`);
    page = await waitForAppPage(browser);
    await page.waitForLoadState("domcontentloaded");
    await page.locator(".recent-row__main", { hasText: projectName }).click();
    await page.getByText("실행 준비").first().waitFor({ state: "visible", timeout: 15_000 });

    await page.getByRole("button", { name: "문서" }).click();
    await page.getByText("산출물 문서").waitFor({ state: "visible", timeout: 15_000 });
    await page.locator(".artifact-document-row", { hasText: "gate-b-spec/spec.json" })
      .getByRole("button", { name: "열기" })
      .click();
    await page.getByRole("dialog", { name: "Spec" }).waitFor({
      state: "visible",
      timeout: 15_000,
    });
    await page.getByText("p2a.spec.v1").waitFor({ state: "visible", timeout: 15_000 });
    await page.getByRole("button", { name: "문서 뷰어 닫기" }).click();

    await page.getByRole("button", { name: "설정" }).click();
    await page.getByText("프로젝트 기본값").waitFor({ state: "visible", timeout: 15_000 });
    await assertInputValue(page.getByLabel("화면 언어"), "ko", "default UI locale");
    await page.getByLabel("화면 언어").selectOption("en");
    await page.getByText("Project defaults").waitFor({ state: "visible", timeout: 15_000 });
    await assertInputValue(
      page.getByLabel("Settings default agent tool"),
      "codex",
      "settings default agent",
    );
    await page.getByText("Developer commands").waitFor({ state: "visible", timeout: 15_000 });

    await page.getByRole("button", { name: "Tasks" }).click();
    await page.getByText("Packaged app smoke task").first().waitFor({
      state: "visible",
      timeout: 15_000,
    });
    await page.getByRole("button", { name: "Start run" }).first().click();
    await page.getByText("Plan2Agent run started").waitFor({ state: "visible", timeout: 20_000 });

    await uncheckIfChecked(page.getByRole("checkbox", { name: "test" }));
    await uncheckIfChecked(page.getByRole("checkbox", { name: "typecheck" }));
    await uncheckIfChecked(page.getByRole("checkbox", { name: "collect git" }));
    await page.getByLabel("Custom verification command").fill(customVerificationCommand);
    await page.getByRole("button", { name: "Finish run" }).click();
    await page.getByText("Plan2Agent run finished").waitFor({ state: "visible", timeout: 20_000 });

    await page.getByRole("button", { name: "Runs" }).click();
    await page.getByText("finished").first().waitFor({ state: "visible", timeout: 15_000 });
    await page.getByText("task-001").first().waitFor({ state: "visible", timeout: 15_000 });
  } catch (error) {
    await mkdir(outRoot, { recursive: true });
    await page?.screenshot({
      path: path.join(outRoot, "packaged-smoke-failure.png"),
      fullPage: true,
    }).catch(() => {});
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}\n${appOutput.tail()}`);
  } finally {
    await closePackagedApp(browser, child);
  }
}

async function assertProjectState({ projectRoot, taskGraphPath }) {
  const taskGraph = await readJson(taskGraphPath);
  const task = taskGraph.tasks.find((item) => item.id === "task-001");
  if (task?.status !== "done") {
    throw new Error(`Expected task-001 to be done, got ${task?.status ?? "missing"}`);
  }

  const runIndex = await readJson(path.join(projectRoot, "runs", "run-index.json"));
  if (runIndex.runs.length !== 1) {
    throw new Error(`Expected exactly one run, got ${runIndex.runs.length}`);
  }
  const runId = runIndex.runs[0].runId;
  const run = await readJson(path.join(projectRoot, "runs", `${runId}.json`));
  const customVerification = run.verification.find(
    (item) => item.command === customVerificationCommand,
  );

  if (run.status !== "finished") {
    throw new Error(`Expected run ${runId} to be finished, got ${run.status}`);
  }
  if (customVerification?.status !== "passed" || customVerification.exitCode !== 0) {
    throw new Error(`Expected custom verification to pass for ${runId}`);
  }
}

async function main() {
  if (!skipPackage) {
    await run(npmCommand(), ["run", "package"], appRoot);
  }

  const executablePath = packagedExecutablePath();
  await assertExecutable(executablePath);

  const tempRoot = await mkdtemp(path.join(tmpdir(), "p2a-gui-packaged-smoke-"));
  const userDataRoot = path.join(tempRoot, "user-data");
  const { projectRoot, taskGraphPath } = await createSmokeProject(tempRoot);
  await seedGuiConfig(userDataRoot, projectRoot);

  try {
    await runUiSmoke({ executablePath, projectRoot, userDataRoot });
    await assertProjectState({ projectRoot, taskGraphPath });
    console.log("Packaged GUI smoke passed");
    console.log(`- executable: ${executablePath}`);
    console.log(`- project: ${projectRoot}`);
  } finally {
    if (!keepTemp) {
      await rm(tempRoot, { recursive: true, force: true });
    } else {
      console.log(`Temp files kept at: ${tempRoot}`);
    }
  }
}

main().catch((error) => {
  console.error(`Packaged GUI smoke failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
