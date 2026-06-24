const bridge = window.p2aGui ?? browserFallbackBridge();

const elements = {
  titleProject: document.querySelector('#title-project'),
  openProject: document.querySelector('#open-project'),
  reloadProject: document.querySelector('#reload-project'),
  railItems: [...document.querySelectorAll('[data-view]')],
  viewPanels: [...document.querySelectorAll('[data-view-panel]')],
  sidebarState: document.querySelector('#sidebar-state'),
  sidebarProject: document.querySelector('#sidebar-project'),
  sidebarSource: document.querySelector('#sidebar-source'),
  sidebarAgent: document.querySelector('#sidebar-agent'),
  recentProjectList: document.querySelector('#recent-project-list'),
  gateList: document.querySelector('#gate-list'),
  readyTaskList: document.querySelector('#ready-task-list'),
  stateTitle: document.querySelector('#state-title'),
  stateDetail: document.querySelector('#state-detail'),
  stateBadge: document.querySelector('#state-badge'),
  actionSummary: document.querySelector('#action-summary'),
  commandList: document.querySelector('#command-list'),
  diagnosticCount: document.querySelector('#diagnostic-count'),
  diagnosticList: document.querySelector('#diagnostic-list'),
  taskSummary: document.querySelector('#task-summary'),
  taskTable: document.querySelector('#task-table'),
  taskDetailCount: document.querySelector('#task-detail-count'),
  taskDetailList: document.querySelector('#task-detail-list'),
  taskDetailTitle: document.querySelector('#task-detail-title'),
  taskDetailStatus: document.querySelector('#task-detail-status'),
  taskDetailMeta: document.querySelector('#task-detail-meta'),
  taskDetailDescription: document.querySelector('#task-detail-description'),
  taskDetailDependencies: document.querySelector('#task-detail-dependencies'),
  taskDetailCriteria: document.querySelector('#task-detail-criteria'),
  taskDetailPrompt: document.querySelector('#task-detail-prompt'),
  taskDetailSourceRefs: document.querySelector('#task-detail-source-refs'),
  runDetailCount: document.querySelector('#run-detail-count'),
  runDetailList: document.querySelector('#run-detail-list'),
  runDetailTitle: document.querySelector('#run-detail-title'),
  runDetailStatus: document.querySelector('#run-detail-status'),
  runDetailMeta: document.querySelector('#run-detail-meta'),
  runDetailTimeline: document.querySelector('#run-detail-timeline'),
  runDetailChangedFiles: document.querySelector('#run-detail-changed-files'),
  runDetailVerification: document.querySelector('#run-detail-verification'),
  runDetailFailure: document.querySelector('#run-detail-failure'),
  runDetailNotes: document.querySelector('#run-detail-notes'),
  artifactCount: document.querySelector('#artifact-count'),
  artifactList: document.querySelector('#artifact-list'),
  artifactTitle: document.querySelector('#artifact-title'),
  artifactPath: document.querySelector('#artifact-path'),
  artifactMeta: document.querySelector('#artifact-meta'),
  artifactContent: document.querySelector('#artifact-content'),
  artifactPreviewMode: document.querySelector('#artifact-preview-mode'),
  artifactRawMode: document.querySelector('#artifact-raw-mode'),
  artifactSearch: document.querySelector('#artifact-search'),
  artifactSearchCount: document.querySelector('#artifact-search-count'),
  artifactSearchPrev: document.querySelector('#artifact-search-prev'),
  artifactSearchNext: document.querySelector('#artifact-search-next'),
  artifactCopyPath: document.querySelector('#artifact-copy-path'),
  artifactCopyContent: document.querySelector('#artifact-copy-content'),
  terminalState: document.querySelector('#terminal-state'),
  terminalTitle: document.querySelector('#terminal-title'),
  terminalCwd: document.querySelector('#terminal-cwd'),
  terminalAgent: document.querySelector('#terminal-agent'),
  terminalTask: document.querySelector('#terminal-task'),
  terminalPreview: document.querySelector('#terminal-preview'),
  inspectorArtifact: document.querySelector('#inspector-artifact'),
  inspectorRuns: document.querySelector('#inspector-runs'),
  inspectorUpdated: document.querySelector('#inspector-updated'),
  jsonPreview: document.querySelector('#json-preview'),
  statusLeft: document.querySelector('#status-left'),
  statusCenter: document.querySelector('#status-center'),
  statusRight: document.querySelector('#status-right'),
};

const stateMeta = {
  no_project: {
    title: 'Open a project',
    detail: 'P2A 프로젝트 폴더를 선택하면 설치 상태와 task/run 요약을 읽습니다.',
    badge: 'idle',
    tone: 'neutral',
  },
  no_p2a: {
    title: 'No P2A',
    detail: '선택한 폴더에 P2A 하네스가 없습니다. setup command를 터미널에서 실행합니다.',
    badge: 'setup',
    tone: 'neutral',
  },
  installed_empty: {
    title: 'Installed empty',
    detail: '하네스는 설치되어 있고 아직 planning artifact가 없습니다. 기획을 시작하거나 승인 산출물을 가져옵니다.',
    badge: 'ready',
    tone: 'warn',
  },
  planning_in_progress: {
    title: 'Planning in progress',
    detail: 'Gate artifact는 있지만 실행 가능한 ready task가 없습니다. Gate 상태와 누락 산출물을 확인합니다.',
    badge: 'planning',
    tone: 'warn',
  },
  execution_ready: {
    title: 'Execution ready',
    detail: '실행 가능한 task 또는 run history가 있습니다. 다음 단계는 Terminal/Tasks 화면에서 감독 실행을 여는 것입니다.',
    badge: 'ready',
    tone: 'ready',
  },
  broken_install: {
    title: 'Broken install',
    detail: '하네스 파일, schema, artifact, run index 중 오류가 있습니다. diagnostics와 validate command를 확인합니다.',
    badge: 'repair',
    tone: 'error',
  },
};

const viewShortcuts = {
  1: 'overview',
  2: 'tasks',
  3: 'runs',
  4: 'artifacts',
  5: 'terminal',
};

let currentPayload = {
  projectPath: null,
  inspection: null,
  artifactCatalog: { documents: [] },
  taskCatalog: { tasks: [] },
  runCatalog: { runs: [] },
  refreshedAt: null,
  trigger: 'initial',
};
let activeView = 'overview';
let selectedArtifactId = null;
let selectedTaskId = null;
let selectedRunId = null;
let artifactRequestToken = 0;
let selectedArtifactDocument = null;
let selectedArtifactContent = '';
let selectedArtifactParseNotice = '';
let artifactViewMode = 'raw';
let artifactSearchQuery = '';
let artifactSearchIndex = 0;

function browserFallbackBridge() {
  return {
    getInitialState: async () => ({
      projectPath: null,
      inspection: null,
      refreshedAt: new Date().toISOString(),
      trigger: 'browser',
    }),
    selectProject: async () => ({
      projectPath: null,
      inspection: null,
      refreshedAt: new Date().toISOString(),
      trigger: 'browser',
    }),
    reloadProject: async () => ({
      ...currentPayload,
      refreshedAt: new Date().toISOString(),
      trigger: 'browser',
    }),
    openRecentProject: async () => ({
      ...currentPayload,
      refreshedAt: new Date().toISOString(),
      trigger: 'browser',
    }),
    readArtifact: async () => ({
      ok: false,
      code: 'browser',
      message: 'Artifact reading is only available in Electron.',
      catalog: { documents: [] },
    }),
    onProjectUpdated: () => () => {},
  };
}

function text(value, fallback = '-') {
  if (value === null || value === undefined || value === '') return fallback;
  return String(value);
}

function shortPath(value) {
  if (!value) return '-';
  const stringValue = String(value);
  if (stringValue.length <= 72) return stringValue;
  return `...${stringValue.slice(-69)}`;
}

function render(payload) {
  currentPayload = payload ?? currentPayload;
  const inspection = currentPayload.inspection;
  const state = inspection?.state ?? 'no_project';
  const meta = stateMeta[state] ?? stateMeta.no_project;
  const projectLabel = inspection?.projectId ?? currentPayload.projectPath ?? 'No project';
  const sourceLabel = inspection?.artifactSource?.sourceLayout ?? '-';
  const diagnostics = inspection?.diagnostics ?? [];
  const readyTasks = inspection?.tasks?.ready ?? [];
  const allTaskSummary = inspection?.tasks;
  const localConfig = currentPayload.localConfig ?? {};
  const artifactCatalog = currentPayload.artifactCatalog ?? { documents: [] };
  const taskCatalog = currentPayload.taskCatalog ?? { tasks: [] };
  const runCatalog = currentPayload.runCatalog ?? { runs: [] };

  elements.titleProject.textContent = projectLabel;
  elements.sidebarState.textContent = state;
  elements.sidebarProject.textContent = shortPath(inspection?.displayPaths?.projectRoot ?? currentPayload.projectPath);
  elements.sidebarSource.textContent = sourceLabel;
  elements.sidebarAgent.textContent = inspection?.defaultAgentTool ?? 'codex';

  elements.stateTitle.textContent = meta.title;
  elements.stateDetail.textContent = meta.detail;
  elements.stateBadge.textContent = meta.badge;
  elements.stateBadge.className = `state-badge ${meta.tone}`;

  renderRecentProjects(localConfig.recentProjects ?? [], currentPayload.projectPath);
  renderGates(inspection?.gates ?? null);
  renderReadyTasks(readyTasks);
  renderOnboardingActions(inspection);
  renderDiagnostics(diagnostics);
  renderTaskTable(inspection);
  renderArtifactList(artifactCatalog.documents ?? []);
  renderTaskDetailList(taskCatalog.tasks ?? []);
  renderRunDetailList(runCatalog.runs ?? []);
  renderTerminalPlaceholder(inspection);

  elements.inspectorArtifact.textContent = shortPath(inspection?.displayPaths?.artifactRoot);
  elements.inspectorRuns.textContent = `${inspection?.runs?.total ?? 0}`;
  elements.inspectorUpdated.textContent = currentPayload.refreshedAt ? new Date(currentPayload.refreshedAt).toLocaleTimeString() : '-';
  elements.jsonPreview.textContent = JSON.stringify(inspection ?? { state: 'no_project' }, null, 2);

  elements.statusLeft.textContent = `${state} · ${currentPayload.trigger ?? 'manual'}`;
  elements.statusCenter.textContent = `cwd: ${shortPath(inspection?.displayPaths?.projectRoot ?? currentPayload.projectPath)}`;
  elements.statusRight.textContent = inspection
    ? `watcher: ${currentPayload.trigger === 'watcher' ? 'reloaded' : 'active'} · tasks ${allTaskSummary?.total ?? 0}`
    : `watcher: standby · recent ${(localConfig.recentProjects ?? []).length}`;

  if (activeView === 'artifacts') ensureArtifactSelection();
  if (activeView === 'tasks') ensureTaskSelection();
  if (activeView === 'runs') ensureRunSelection();
}

function setActiveView(view) {
  activeView = ['artifacts', 'tasks', 'runs', 'terminal'].includes(view) ? view : 'overview';
  for (const button of elements.railItems) {
    const isActive = button.dataset.view === activeView;
    button.classList.toggle('active', isActive);
    button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  }
  for (const panel of elements.viewPanels) {
    panel.hidden = panel.dataset.viewPanel !== activeView;
    panel.classList.toggle('active', panel.dataset.viewPanel === activeView);
  }
  if (activeView === 'artifacts') ensureArtifactSelection();
  if (activeView === 'tasks') ensureTaskSelection();
  if (activeView === 'runs') ensureRunSelection();
}

function renderRecentProjects(projects, activePath) {
  elements.recentProjectList.replaceChildren();
  if (!projects.length) {
    elements.recentProjectList.append(emptyNode('No recent project'));
    return;
  }
  for (const project of projects.slice(0, 6)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `recent-project-row ${project.path === activePath ? 'active' : ''}`;
    button.title = project.path;
    button.addEventListener('click', async () => {
      render(await bridge.openRecentProject(project.path));
    });

    const main = document.createElement('span');
    main.className = 'recent-main';
    const name = document.createElement('span');
    name.className = 'recent-name';
    name.textContent = text(project.projectId);
    const projectPath = document.createElement('span');
    projectPath.className = 'recent-path';
    projectPath.textContent = shortPath(project.path);
    main.append(name, projectPath);

    const state = document.createElement('span');
    state.className = 'recent-state';
    state.textContent = text(project.state);

    button.append(main, state);
    elements.recentProjectList.append(button);
  }
}

function artifactDocuments() {
  return currentPayload.artifactCatalog?.documents ?? [];
}

function taskItems() {
  return currentPayload.taskCatalog?.tasks ?? [];
}

function runItems() {
  return currentPayload.runCatalog?.runs ?? [];
}

function renderRunDetailList(runs) {
  elements.runDetailList.replaceChildren();
  elements.runDetailCount.textContent = `${runs.length} run${runs.length === 1 ? '' : 's'}`;
  if (!runs.length) {
    elements.runDetailList.append(emptyNode(currentPayload.runCatalog?.error ? 'Run index invalid' : 'No run history'));
    if (activeView === 'runs') renderRunEmpty();
    return;
  }

  if (selectedRunId && !runs.some((run) => run.runId === selectedRunId)) selectedRunId = null;

  for (const run of runs) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.runId = run.runId;
    button.className = `run-detail-row ${run.runId === selectedRunId ? 'active' : ''}`;
    button.title = `${run.runId} · ${run.taskId}`;
    button.addEventListener('click', () => selectRun(run.runId));

    const main = document.createElement('span');
    main.className = 'run-detail-main';
    const title = document.createElement('span');
    title.className = 'run-detail-row-title';
    title.textContent = `${run.runId} · ${run.taskId}`;
    const meta = document.createElement('span');
    meta.className = 'run-detail-row-meta';
    meta.textContent = `${run.agentTool} · ${formatDateTime(run.startedAt)}`;
    main.append(title, meta);

    const status = document.createElement('span');
    status.className = `status-pill ${run.status}`;
    status.textContent = run.status;

    button.append(main, status);
    elements.runDetailList.append(button);
  }
}

function renderRunEmpty() {
  elements.runDetailTitle.textContent = 'No run selected';
  elements.runDetailStatus.textContent = '-';
  elements.runDetailStatus.className = 'status-pill';
  elements.runDetailMeta.textContent = currentPayload.runCatalog?.error ?? '-';
  elements.runDetailTimeline.replaceChildren(emptyNode('No timeline'));
  elements.runDetailChangedFiles.replaceChildren(emptyNode('No changed files'));
  elements.runDetailVerification.replaceChildren(emptyNode('No verification'));
  elements.runDetailFailure.textContent = '-';
  elements.runDetailNotes.replaceChildren(emptyNode('No notes'));
}

function ensureRunSelection() {
  const runs = runItems();
  if (!runs.length) {
    selectedRunId = null;
    renderRunEmpty();
    return;
  }
  const selectedRun = runs.find((run) => run.runId === selectedRunId) ?? runs[0];
  selectRun(selectedRun.runId);
}

function selectRun(runId) {
  selectedRunId = runId;
  renderRunDetailList(runItems());
  const run = runItems().find((item) => item.runId === runId);
  if (!run) {
    renderRunEmpty();
    return;
  }

  elements.runDetailTitle.textContent = run.taskTitle ?? run.runId;
  elements.runDetailStatus.textContent = run.status;
  elements.runDetailStatus.className = `status-pill ${run.status}`;
  elements.runDetailMeta.textContent = `${run.runId} · ${run.taskId} · ${run.agentTool} · ${run.workspaceRef}`;
  renderRunTimeline(run);
  renderChangedFiles(run.changedFiles);
  renderVerification(run.verification);
  renderFailure(run);
  renderNotes(run.notes);
}

function renderRunTimeline(run) {
  elements.runDetailTimeline.replaceChildren();
  const items = [
    ['started', formatDateTime(run.startedAt)],
    ['updated', formatDateTime(run.updatedAt)],
    ['finished', formatDateTime(run.finishedAt)],
    ['workspace', run.workspacePath ?? run.workspaceRef],
    ['isolation', run.isolation?.mode ?? '-'],
  ];
  for (const [label, value] of items) {
    const row = document.createElement('div');
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = label;
    dd.textContent = text(value);
    row.append(dt, dd);
    elements.runDetailTimeline.append(row);
  }
}

function renderChangedFiles(files) {
  elements.runDetailChangedFiles.replaceChildren();
  if (!files?.length) {
    elements.runDetailChangedFiles.append(emptyNode('No changed files'));
    return;
  }
  for (const file of files) {
    const row = document.createElement('div');
    row.className = 'changed-file-row';
    row.textContent = file;
    elements.runDetailChangedFiles.append(row);
  }
}

function renderVerification(items) {
  elements.runDetailVerification.replaceChildren();
  if (!items?.length) {
    elements.runDetailVerification.append(emptyNode('No verification'));
    return;
  }
  for (const item of items) {
    const row = document.createElement('div');
    row.className = `verification-row ${item.status}`;
    const head = document.createElement('div');
    head.className = 'verification-head';
    head.append(labelNode(`${item.type} · ${item.status}`, 'verification-title'));
    head.append(labelNode(item.exitCode === null ? 'exit -' : `exit ${item.exitCode}`, 'verification-exit'));
    const command = labelNode(item.command, 'verification-command');
    row.append(head, command);
    if (item.stderrTail) row.append(labelNode(item.stderrTail, 'verification-tail'));
    else if (item.stdoutTail) row.append(labelNode(item.stdoutTail, 'verification-tail'));
    elements.runDetailVerification.append(row);
  }
}

function renderFailure(run) {
  if (!run.valid) {
    elements.runDetailFailure.textContent = run.error ?? 'Run file is invalid.';
    return;
  }
  if (!run.failure) {
    elements.runDetailFailure.textContent = 'None';
    return;
  }
  elements.runDetailFailure.textContent = `${run.failure.class} · retry ${run.failure.retryable} · source ${run.failure.source} · user decision ${run.failure.needsUserDecision}`;
}

function renderNotes(notes) {
  elements.runDetailNotes.replaceChildren();
  if (!notes?.length) {
    elements.runDetailNotes.append(emptyNode('No notes'));
    return;
  }
  for (const note of notes) {
    const row = document.createElement('div');
    row.className = 'note-row';
    row.textContent = note;
    elements.runDetailNotes.append(row);
  }
}

function renderTaskDetailList(tasks) {
  elements.taskDetailList.replaceChildren();
  elements.taskDetailCount.textContent = `${tasks.length} task${tasks.length === 1 ? '' : 's'}`;
  if (!tasks.length) {
    elements.taskDetailList.append(emptyNode(currentPayload.taskCatalog?.error ? 'Task graph invalid' : 'No task graph'));
    if (activeView === 'tasks') renderTaskEmpty();
    return;
  }

  if (selectedTaskId && !tasks.some((task) => task.id === selectedTaskId)) selectedTaskId = null;

  for (const task of tasks) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.taskId = task.id;
    button.className = `task-detail-row ${task.id === selectedTaskId ? 'active' : ''}`;
    button.title = `${task.id} · ${task.title}`;
    button.addEventListener('click', () => selectTask(task.id));

    const main = document.createElement('span');
    main.className = 'task-detail-main';
    const title = document.createElement('span');
    title.className = 'task-detail-row-title';
    title.textContent = `${task.id} · ${task.title}`;
    const meta = document.createElement('span');
    meta.className = 'task-detail-row-meta';
    meta.textContent = task.targetArea;
    main.append(title, meta);

    const status = document.createElement('span');
    status.className = `status-pill ${task.ready ? 'ready' : task.status}`;
    status.textContent = task.ready ? 'ready' : task.status;

    button.append(main, status);
    elements.taskDetailList.append(button);
  }
}

function renderTaskEmpty() {
  elements.taskDetailTitle.textContent = 'No task selected';
  elements.taskDetailStatus.textContent = '-';
  elements.taskDetailStatus.className = 'status-pill';
  elements.taskDetailMeta.textContent = currentPayload.taskCatalog?.error ?? '-';
  elements.taskDetailDescription.textContent = 'Open a P2A project and select a task.';
  elements.taskDetailDependencies.replaceChildren(emptyNode('No dependencies'));
  elements.taskDetailCriteria.replaceChildren(emptyNode('No acceptance criteria'));
  elements.taskDetailPrompt.textContent = '-';
  elements.taskDetailSourceRefs.replaceChildren(emptyNode('No source refs'));
}

function ensureTaskSelection() {
  const tasks = taskItems();
  if (!tasks.length) {
    selectedTaskId = null;
    renderTaskEmpty();
    return;
  }
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? tasks.find((task) => task.ready) ?? tasks[0];
  selectTask(selectedTask.id);
}

function selectTask(taskId) {
  selectedTaskId = taskId;
  renderTaskDetailList(taskItems());
  const task = taskItems().find((item) => item.id === taskId);
  if (!task) {
    renderTaskEmpty();
    return;
  }

  elements.taskDetailTitle.textContent = task.title;
  elements.taskDetailStatus.textContent = task.ready ? 'ready' : task.status;
  elements.taskDetailStatus.className = `status-pill ${task.ready ? 'ready' : task.status}`;
  const dependencyText = task.dependencies.length
    ? `${task.dependencies.length} dep · blocked by ${task.blockedBy.length}`
    : 'no deps';
  elements.taskDetailMeta.textContent = `${task.id} · ${task.targetArea} · ${dependencyText}`;
  elements.taskDetailDescription.textContent = task.description;
  renderTokenList(elements.taskDetailDependencies, task.dependencies, task.blockedBy);
  renderCriteriaList(task.acceptanceCriteria);
  elements.taskDetailPrompt.textContent = task.suggestedAgentPrompt;
  renderTokenList(elements.taskDetailSourceRefs, task.sourceSpecRefs, []);
}

function renderTokenList(container, values, blockedValues = []) {
  container.replaceChildren();
  if (!values?.length) {
    container.append(emptyNode('None'));
    return;
  }
  for (const value of values) {
    const node = document.createElement('span');
    node.className = `token ${blockedValues.includes(value) ? 'blocked' : ''}`;
    node.textContent = value;
    container.append(node);
  }
}

function renderCriteriaList(criteria) {
  elements.taskDetailCriteria.replaceChildren();
  if (!criteria?.length) {
    elements.taskDetailCriteria.append(emptyNode('No acceptance criteria'));
    return;
  }
  for (const item of criteria) {
    const row = document.createElement('div');
    row.className = 'criterion-row';
    row.textContent = item;
    elements.taskDetailCriteria.append(row);
  }
}

function renderArtifactList(documents) {
  elements.artifactList.replaceChildren();
  elements.artifactCount.textContent = `${documents.length} document${documents.length === 1 ? '' : 's'}`;
  if (!documents.length) {
    elements.artifactList.append(emptyNode('No artifact document'));
    if (activeView === 'artifacts') renderArtifactEmpty('No artifact document', '-');
    return;
  }

  if (selectedArtifactId && !documents.some((artifact) => artifact.id === selectedArtifactId)) {
    selectedArtifactId = null;
  }

  for (const artifact of documents) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.artifactId = artifact.id;
    button.className = `artifact-row ${artifact.id === selectedArtifactId ? 'active' : ''}`;
    button.title = artifact.displayPath ?? artifact.path;
    button.addEventListener('click', () => selectArtifact(artifact.id));

    const main = document.createElement('span');
    main.className = 'artifact-main';
    const label = document.createElement('span');
    label.className = 'artifact-label';
    label.textContent = artifact.label;
    const artifactPath = document.createElement('span');
    artifactPath.className = 'artifact-row-path';
    artifactPath.textContent = artifact.displayPath ?? artifact.path;
    main.append(label, artifactPath);

    const group = document.createElement('span');
    group.className = 'artifact-group';
    group.textContent = artifact.group;

    button.append(main, group);
    elements.artifactList.append(button);
  }
}

function renderTerminalPlaceholder(inspection) {
  const agentTool = inspection?.defaultAgentTool ?? 'codex';
  const projectRoot = inspection?.displayPaths?.projectRoot ?? currentPayload.projectPath;
  const task = taskItems().find((item) => item.ready) ?? taskItems()[0];
  const taskLabel = task ? `${task.id} · ${task.title}` : '-';

  elements.terminalState.textContent = inspection ? 'read-only' : 'not connected';
  elements.terminalTitle.textContent = inspection ? 'PTY not connected' : 'No project';
  elements.terminalCwd.textContent = shortPath(projectRoot);
  elements.terminalCwd.title = text(projectRoot);
  elements.terminalAgent.textContent = agentTool;
  elements.terminalTask.textContent = taskLabel;
  elements.terminalTask.title = taskLabel;
  elements.terminalPreview.textContent = [
    `cwd   ${text(projectRoot)}`,
    `agent ${agentTool}`,
    `task  ${taskLabel}`,
    'pty   not connected',
  ].join('\n');
}

function buildOnboardingActions(inspection) {
  const state = inspection?.state ?? 'no_project';
  const commands = inspection?.commands ?? {};
  const projectRoot = inspection?.displayPaths?.projectRoot ?? currentPayload.projectPath ?? '-';
  const artifactRoot = inspection?.displayPaths?.artifactRoot ?? '<artifact-root>';
  const hasReadyTask = (inspection?.tasks?.ready ?? []).length > 0;
  const actionByState = {
    no_project: [
      {
        title: 'Open P2A project',
        state: 'folder picker',
        target: 'workspace',
        result: 'read model',
        buttonLabel: 'Open',
        intent: 'openProject',
      },
    ],
    no_p2a: [
      {
        title: 'Install P2A',
        state: 'copy command',
        target: projectRoot,
        result: '.plan2agent, scripts, schemas',
        command: commands.setup,
        primary: true,
      },
      {
        title: 'Import plan',
        state: 'copy command',
        target: projectRoot,
        result: 'approved artifacts',
        command: commands.import,
      },
    ],
    installed_empty: [
      {
        title: 'Import plan',
        state: 'copy command',
        target: projectRoot,
        result: 'approved artifacts',
        command: commands.import,
        primary: true,
      },
      {
        title: 'Validate target',
        state: 'copy command',
        target: artifactRoot,
        result: 'artifact audit',
        command: commands.validate,
      },
    ],
    planning_in_progress: [
      {
        title: 'Validate gates',
        state: 'copy command',
        target: artifactRoot,
        result: 'missing gate check',
        command: commands.validate,
        primary: true,
      },
      {
        title: 'Review artifacts',
        state: 'open view',
        target: artifactRoot,
        result: 'read-only documents',
        view: 'artifacts',
        buttonLabel: 'Open',
      },
    ],
    execution_ready: [
      {
        title: hasReadyTask ? 'Open ready task' : 'Open tasks',
        state: 'open view',
        target: projectRoot,
        result: hasReadyTask ? `${inspection.tasks.ready.length} ready` : 'task graph',
        view: 'tasks',
        buttonLabel: 'Open',
        primary: true,
      },
      {
        title: 'Terminal scope',
        state: 'open view',
        target: projectRoot,
        result: inspection?.defaultAgentTool ?? 'codex',
        view: 'terminal',
        buttonLabel: 'Open',
      },
      {
        title: 'Validate artifacts',
        state: 'copy command',
        target: artifactRoot,
        result: 'gate audit',
        command: commands.validate,
      },
    ],
    broken_install: [
      {
        title: 'Validate install',
        state: 'copy command',
        target: artifactRoot,
        result: `${inspection?.diagnostics?.length ?? 0} diagnostics`,
        command: commands.validate,
        primary: true,
      },
      {
        title: 'Repair harness',
        state: 'copy command',
        target: projectRoot,
        result: 'missing files',
        command: commands.setup,
      },
    ],
  };
  return actionByState[state] ?? actionByState.no_project;
}

function renderOnboardingActions(inspection) {
  const actions = buildOnboardingActions(inspection);
  elements.actionSummary.textContent = `${actions.length} action${actions.length === 1 ? '' : 's'}`;
  elements.commandList.replaceChildren();
  for (const action of actions) {
    const row = document.createElement('div');
    row.className = `action-row ${action.primary ? 'primary' : ''}`;

    const head = document.createElement('div');
    head.className = 'action-head';
    head.append(labelNode(action.title, 'action-title'));
    head.append(labelNode(action.state, 'action-state'));

    const meta = document.createElement('dl');
    meta.className = 'action-meta';
    meta.append(actionMetaNode('target', action.target));
    meta.append(actionMetaNode('result', action.result));

    row.append(head, meta);
    row.append(actionControlNode(action));
    elements.commandList.append(row);
  }
}

function actionMetaNode(label, value) {
  const row = document.createElement('div');
  const dt = document.createElement('dt');
  const dd = document.createElement('dd');
  dt.textContent = label;
  dd.textContent = text(value);
  dd.title = text(value);
  row.append(dt, dd);
  return row;
}

function actionControlNode(action) {
  const row = document.createElement('div');
  row.className = 'action-control';

  const command = document.createElement('code');
  command.className = 'action-command-text';
  command.textContent = action.command ?? action.view ?? action.intent ?? '-';
  command.title = command.textContent;

  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = action.buttonLabel ?? 'Copy';
  button.disabled = !action.command && !action.view && !action.intent;
  button.addEventListener('click', async () => {
    if (action.command) {
      await copyText(action.command);
      return;
    }
    if (action.view) {
      setActiveView(action.view);
      requestAnimationFrame(focusActiveListRow);
      return;
    }
    if (action.intent === 'openProject') render(await bridge.selectProject());
  });

  row.append(command, button);
  return row;
}

function isTextEditingTarget(target) {
  if (!target || !(target instanceof HTMLElement)) return false;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable;
}

function activeListConfig() {
  if (activeView === 'artifacts') {
    return {
      rowSelector: '.artifact-row',
      idAttribute: 'artifactId',
      selectedId: selectedArtifactId,
      select: selectArtifact,
    };
  }
  if (activeView === 'tasks') {
    return {
      rowSelector: '.task-detail-row',
      idAttribute: 'taskId',
      selectedId: selectedTaskId,
      select: selectTask,
    };
  }
  if (activeView === 'runs') {
    return {
      rowSelector: '.run-detail-row',
      idAttribute: 'runId',
      selectedId: selectedRunId,
      select: selectRun,
    };
  }
  return null;
}

function activeListRows(config) {
  if (!config) return [];
  return [...document.querySelectorAll(config.rowSelector)];
}

function selectedListIndex(config, rows) {
  const focusedIndex = rows.findIndex((row) => row === document.activeElement);
  if (focusedIndex >= 0) return focusedIndex;
  const selectedIndex = rows.findIndex((row) => row.dataset[config.idAttribute] === config.selectedId);
  return selectedIndex >= 0 ? selectedIndex : 0;
}

function focusActiveListRow() {
  const config = activeListConfig();
  const rows = activeListRows(config);
  if (!rows.length) return;
  const index = selectedListIndex(config, rows);
  rows[index]?.focus();
}

function handleListNavigation(event) {
  if (!['ArrowUp', 'ArrowDown', 'Enter'].includes(event.key) || isTextEditingTarget(event.target)) return;
  const config = activeListConfig();
  const rows = activeListRows(config);
  if (!config || !rows.length) return;

  const panel = document.querySelector(`[data-view-panel="${activeView}"]`);
  const target = event.target instanceof HTMLElement ? event.target : null;
  const isInsidePanel = target ? panel?.contains(target) : false;
  const isInsideRail = target?.closest?.('.activity-rail');
  if (!isInsidePanel && !isInsideRail && target !== document.body) return;

  const currentIndex = selectedListIndex(config, rows);
  if (event.key === 'Enter') {
    const row = rows[currentIndex];
    const id = row?.dataset[config.idAttribute];
    if (!id) return;
    event.preventDefault();
    config.select(id);
    requestAnimationFrame(focusActiveListRow);
    return;
  }

  event.preventDefault();
  const direction = event.key === 'ArrowDown' ? 1 : -1;
  const nextIndex = Math.max(0, Math.min(rows.length - 1, currentIndex + direction));
  const nextRow = rows[nextIndex];
  const nextId = nextRow?.dataset[config.idAttribute];
  if (!nextId) return;
  config.select(nextId);
  requestAnimationFrame(focusActiveListRow);
}

function handleKeyboard(event) {
  const shortcutView = viewShortcuts[event.key];
  if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && shortcutView) {
    event.preventDefault();
    setActiveView(shortcutView);
    requestAnimationFrame(focusActiveListRow);
    return;
  }
  handleListNavigation(event);
}

function renderArtifactEmpty(title, detail) {
  selectedArtifactDocument = null;
  selectedArtifactContent = '';
  selectedArtifactParseNotice = '';
  artifactViewMode = 'raw';
  artifactSearchQuery = '';
  artifactSearchIndex = 0;
  elements.artifactSearch.value = '';
  elements.artifactTitle.textContent = title;
  elements.artifactPath.textContent = detail;
  elements.artifactMeta.textContent = '-';
  updateArtifactToolbar();
  renderPlainArtifactContent('Open a P2A project and select an artifact.');
}

function renderArtifactLoading(document) {
  selectedArtifactDocument = document ?? null;
  selectedArtifactContent = '';
  selectedArtifactParseNotice = '';
  artifactSearchQuery = '';
  artifactSearchIndex = 0;
  elements.artifactSearch.value = '';
  artifactViewMode = document?.format === 'markdown' ? 'preview' : 'raw';
  elements.artifactTitle.textContent = document?.label ?? 'Loading artifact';
  elements.artifactPath.textContent = document?.displayPath ?? '-';
  elements.artifactMeta.textContent = document ? `${document.group} · ${document.format}` : '-';
  updateArtifactToolbar();
  renderPlainArtifactContent('Loading...');
}

function renderArtifactReadResult(result) {
  if (!result?.ok) {
    selectedArtifactDocument = result?.document ?? null;
    selectedArtifactContent = '';
    selectedArtifactParseNotice = '';
    elements.artifactTitle.textContent = 'Artifact unavailable';
    elements.artifactPath.textContent = result?.code ?? '-';
    elements.artifactMeta.textContent = '-';
    updateArtifactToolbar();
    renderPlainArtifactContent(result?.message ?? 'Could not read artifact.');
    return;
  }

  const document = result.document;
  const modified = document.modifiedAt ? new Date(document.modifiedAt).toLocaleString() : '-';
  selectedArtifactDocument = document;
  selectedArtifactContent = result.content ?? '';
  selectedArtifactParseNotice = result.parseError ? `JSON parse warning: ${result.parseError}\n\n` : '';
  if (document.format !== 'markdown') artifactViewMode = 'raw';
  elements.artifactTitle.textContent = document.label;
  elements.artifactPath.textContent = document.displayPath ?? document.path;
  elements.artifactMeta.textContent = `${document.group} · ${document.format} · ${formatBytes(document.sizeBytes)} · ${modified}`;
  updateArtifactToolbar();
  renderSelectedArtifactContent();
}

function updateArtifactToolbar() {
  const hasDocument = Boolean(selectedArtifactDocument);
  const hasContent = Boolean(selectedArtifactContent || selectedArtifactParseNotice);
  const canPreview = selectedArtifactDocument?.format === 'markdown';
  if (!canPreview) artifactViewMode = 'raw';
  elements.artifactPreviewMode.disabled = !canPreview || !hasContent;
  elements.artifactRawMode.disabled = !hasContent;
  elements.artifactPreviewMode.classList.toggle('active', artifactViewMode === 'preview');
  elements.artifactRawMode.classList.toggle('active', artifactViewMode === 'raw');
  elements.artifactPreviewMode.setAttribute('aria-pressed', artifactViewMode === 'preview' ? 'true' : 'false');
  elements.artifactRawMode.setAttribute('aria-pressed', artifactViewMode === 'raw' ? 'true' : 'false');
  elements.artifactSearch.disabled = !hasContent;
  const matchCount = countMatches(artifactDisplayContent(), artifactSearchQuery.trim());
  elements.artifactSearchPrev.disabled = matchCount < 2;
  elements.artifactSearchNext.disabled = matchCount < 2;
  elements.artifactCopyPath.disabled = !hasDocument;
  elements.artifactCopyContent.disabled = !hasContent;
}

function artifactDisplayContent() {
  return `${selectedArtifactParseNotice}${selectedArtifactContent}`;
}

function renderSelectedArtifactContent() {
  const query = artifactSearchQuery.trim();
  const content = artifactDisplayContent();
  const matchCount = countMatches(content, query);
  if (!matchCount) artifactSearchIndex = 0;
  else if (artifactSearchIndex >= matchCount) artifactSearchIndex = 0;
  elements.artifactSearchCount.textContent = query ? `${matchCount}` : '0';
  elements.artifactSearchPrev.disabled = matchCount < 2;
  elements.artifactSearchNext.disabled = matchCount < 2;

  elements.artifactContent.replaceChildren();
  elements.artifactContent.className = `artifact-content ${artifactViewMode}`;
  if (artifactViewMode === 'preview' && selectedArtifactDocument?.format === 'markdown') {
    renderMarkdownArtifact(elements.artifactContent, content, query);
  } else {
    renderHighlightedTextBlock(elements.artifactContent, content, query);
  }
  requestAnimationFrame(() => {
    elements.artifactContent.querySelector('mark.active')?.scrollIntoView({ block: 'center', inline: 'nearest' });
  });
  updateArtifactToolbar();
}

function renderPlainArtifactContent(value) {
  elements.artifactSearchCount.textContent = '0';
  elements.artifactContent.className = 'artifact-content raw';
  elements.artifactContent.replaceChildren();
  elements.artifactContent.textContent = value;
}

function countMatches(value, query) {
  if (!query) return 0;
  const haystack = value.toLocaleLowerCase();
  const needle = query.toLocaleLowerCase();
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function renderHighlightedTextBlock(container, value, query) {
  const search = { query, current: 0, active: artifactSearchIndex };
  appendHighlightedText(container, value, search);
}

function appendHighlightedText(container, value, search) {
  if (!search.query) {
    container.append(document.createTextNode(value));
    return;
  }
  const lowerValue = value.toLocaleLowerCase();
  const lowerQuery = search.query.toLocaleLowerCase();
  let cursor = 0;
  let matchIndex = lowerValue.indexOf(lowerQuery);
  while (matchIndex >= 0) {
    if (matchIndex > cursor) {
      container.append(document.createTextNode(value.slice(cursor, matchIndex)));
    }
    const mark = document.createElement('mark');
    mark.textContent = value.slice(matchIndex, matchIndex + search.query.length);
    if (search.current === search.active) mark.className = 'active';
    search.current += 1;
    container.append(mark);
    cursor = matchIndex + search.query.length;
    matchIndex = lowerValue.indexOf(lowerQuery, cursor);
  }
  if (cursor < value.length) container.append(document.createTextNode(value.slice(cursor)));
}

function appendInlineMarkdown(container, value, search) {
  const parts = value.split(/(`[^`]+`)/g);
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith('`') && part.endsWith('`') && part.length > 1) {
      const code = document.createElement('code');
      appendHighlightedText(code, part.slice(1, -1), search);
      container.append(code);
      continue;
    }
    appendHighlightedText(container, part, search);
  }
}

function renderMarkdownArtifact(container, markdown, query) {
  const lines = markdown.split(/\r?\n/);
  const search = { query, current: 0, active: artifactSearchIndex };
  let paragraph = [];
  let list = null;
  let codeBlock = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const p = document.createElement('p');
    appendInlineMarkdown(p, paragraph.join(' '), search);
    container.append(p);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    container.append(list.node);
    list = null;
  };
  const flushCodeBlock = () => {
    if (!codeBlock) return;
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    appendHighlightedText(code, codeBlock.lines.join('\n'), search);
    pre.append(code);
    container.append(pre);
    codeBlock = null;
  };
  const flushBlocks = () => {
    flushParagraph();
    flushList();
    flushCodeBlock();
  };

  for (const line of lines) {
    const fence = line.match(/^```/);
    if (fence) {
      if (codeBlock) flushCodeBlock();
      else {
        flushParagraph();
        flushList();
        codeBlock = { lines: [] };
      }
      continue;
    }
    if (codeBlock) {
      codeBlock.lines.push(line);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = Math.min(heading[1].length, 4);
      const node = document.createElement(`h${level}`);
      appendInlineMarkdown(node, heading[2], search);
      container.append(node);
      continue;
    }

    if (/^\s*---+\s*$/.test(line)) {
      flushBlocks();
      container.append(document.createElement('hr'));
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      flushList();
      const blockquote = document.createElement('blockquote');
      appendInlineMarkdown(blockquote, quote[1], search);
      container.append(blockquote);
      continue;
    }

    const unordered = line.match(/^\s*[-*]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph();
      const type = ordered ? 'ol' : 'ul';
      if (!list || list.type !== type) {
        flushList();
        list = { type, node: document.createElement(type) };
      }
      const item = document.createElement('li');
      appendInlineMarkdown(item, unordered?.[1] ?? ordered[1], search);
      list.node.append(item);
      continue;
    }

    paragraph.push(line.trim());
  }
  flushBlocks();
}

function ensureArtifactSelection() {
  const documents = artifactDocuments();
  if (!documents.length) {
    selectedArtifactId = null;
    renderArtifactEmpty('No artifact document', '-');
    return;
  }
  const selectedDocument = documents.find((artifact) => artifact.id === selectedArtifactId) ?? documents[0];
  if (selectedDocument.id !== selectedArtifactId) {
    selectArtifact(selectedDocument.id);
  }
}

async function selectArtifact(artifactId) {
  selectedArtifactId = artifactId;
  renderArtifactList(artifactDocuments());
  const document = artifactDocuments().find((item) => item.id === artifactId);
  renderArtifactLoading(document);
  const token = (artifactRequestToken += 1);
  const result = await bridge.readArtifact(artifactId);
  if (token !== artifactRequestToken || selectedArtifactId !== artifactId) return;
  if (result?.catalog) currentPayload.artifactCatalog = result.catalog;
  renderArtifactList(artifactDocuments());
  renderArtifactReadResult(result);
}

function renderGates(gates) {
  elements.gateList.replaceChildren();
  if (!gates) {
    elements.gateList.append(emptyNode('No gate artifacts'));
    return;
  }
  for (const gate of Object.values(gates)) {
    const row = document.createElement('div');
    row.className = 'row';
    row.append(labelNode(gate.label, 'row-title'));
    row.append(pillNode(gate.status, gate.status));
    elements.gateList.append(row);
  }
}

function renderReadyTasks(tasks) {
  elements.readyTaskList.replaceChildren();
  if (!tasks.length) {
    elements.readyTaskList.append(emptyNode('No ready task'));
    return;
  }
  for (const task of tasks.slice(0, 8)) {
    const row = document.createElement('div');
    row.className = 'row';
    row.append(labelNode(`${task.id} · ${task.title}`, 'row-title'));
    row.append(pillNode(task.targetArea ?? 'area', 'present'));
    elements.readyTaskList.append(row);
  }
}

function renderDiagnostics(diagnostics) {
  elements.diagnosticList.replaceChildren();
  elements.diagnosticCount.textContent = `${diagnostics.length}`;
  if (!diagnostics.length) {
    elements.diagnosticList.append(emptyNode('No diagnostics'));
    return;
  }
  for (const item of diagnostics) {
    const row = document.createElement('div');
    row.className = `diagnostic-row ${item.severity === 'error' ? 'error' : ''}`;
    row.append(labelNode(`${item.severity} · ${item.code}`, 'diagnostic-code'));
    row.append(labelNode(item.message, 'diagnostic-message'));
    if (item.path) row.append(labelNode(shortPath(item.path), 'diagnostic-message mono'));
    elements.diagnosticList.append(row);
  }
}

function renderTaskTable(inspection) {
  elements.taskTable.replaceChildren();
  const readyTasks = inspection?.tasks?.ready ?? [];
  const total = inspection?.tasks?.total ?? 0;
  elements.taskSummary.textContent = `${total} tasks · ${readyTasks.length} ready`;
  if (!readyTasks.length) {
    elements.taskTable.append(emptyNode('No ready task from current graph'));
    return;
  }
  for (const task of readyTasks) {
    const row = document.createElement('div');
    row.className = 'task-row';
    row.append(labelNode(task.id, 'task-id'));
    row.append(labelNode(task.title, 'task-title'));
    row.append(labelNode(task.targetArea ?? '-', 'task-meta'));
    row.append(labelNode(`${task.acceptanceCriteriaCount ?? 0} AC`, 'task-meta'));
    elements.taskTable.append(row);
  }
}

function labelNode(value, className) {
  const node = document.createElement('div');
  node.className = className;
  node.textContent = text(value);
  node.title = text(value);
  return node;
}

function pillNode(value, status) {
  const node = document.createElement('span');
  node.className = `pill ${status === 'present' ? 'present' : 'missing'}`;
  node.textContent = text(value);
  return node;
}

function emptyNode(value) {
  const node = document.createElement('div');
  node.className = 'empty';
  node.textContent = value;
  return node;
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return '-';
  if (value < 1024) return `${value} B`;
  return `${(value / 1024).toFixed(1)} KB`;
}

function formatDateTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    // Clipboard availability depends on platform permissions.
  }
}

async function boot() {
  document.addEventListener('keydown', handleKeyboard);
  elements.artifactPreviewMode.addEventListener('click', () => {
    artifactViewMode = 'preview';
    renderSelectedArtifactContent();
  });
  elements.artifactRawMode.addEventListener('click', () => {
    artifactViewMode = 'raw';
    renderSelectedArtifactContent();
  });
  elements.artifactSearch.addEventListener('input', () => {
    artifactSearchQuery = elements.artifactSearch.value;
    artifactSearchIndex = 0;
    renderSelectedArtifactContent();
  });
  elements.artifactSearchPrev.addEventListener('click', () => {
    const matches = countMatches(artifactDisplayContent(), artifactSearchQuery.trim());
    if (matches < 2) return;
    artifactSearchIndex = (artifactSearchIndex + matches - 1) % matches;
    renderSelectedArtifactContent();
  });
  elements.artifactSearchNext.addEventListener('click', () => {
    const matches = countMatches(artifactDisplayContent(), artifactSearchQuery.trim());
    if (matches < 2) return;
    artifactSearchIndex = (artifactSearchIndex + 1) % matches;
    renderSelectedArtifactContent();
  });
  elements.artifactCopyPath.addEventListener('click', () => {
    if (selectedArtifactDocument?.path) copyText(selectedArtifactDocument.path);
  });
  elements.artifactCopyContent.addEventListener('click', () => {
    if (selectedArtifactContent || selectedArtifactParseNotice) copyText(artifactDisplayContent());
  });
  for (const button of elements.railItems) {
    button.addEventListener('click', () => setActiveView(button.dataset.view));
  }
  elements.openProject.addEventListener('click', async () => {
    render(await bridge.selectProject());
  });
  elements.reloadProject.addEventListener('click', async () => {
    render(await bridge.reloadProject());
  });
  bridge.onProjectUpdated((payload) => render(payload));
  setActiveView('overview');
  render(await bridge.getInitialState());
}

boot().catch((error) => {
  render({
    projectPath: null,
    inspection: {
      state: 'broken_install',
      stateLabel: 'Broken install',
      diagnostics: [
        {
          severity: 'error',
          code: 'renderer_boot_failed',
          message: error.message,
        },
      ],
      tasks: { total: 0, ready: [], byStatus: {} },
      runs: { total: 0 },
      commands: {},
      displayPaths: {},
    },
    artifactCatalog: { documents: [] },
    taskCatalog: { tasks: [] },
    runCatalog: { runs: [] },
    localConfig: { recentProjects: [] },
    refreshedAt: new Date().toISOString(),
    trigger: 'renderer',
  });
});
