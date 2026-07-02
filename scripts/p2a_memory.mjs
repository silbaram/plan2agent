#!/usr/bin/env node
/** Sync Plan2Agent local artifacts with a Plan2Agent Memory server. */

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  loadJson,
  validateRunData,
  validateRunIndexData,
  validateSkillProposal,
  validateTaskGraph,
} from './validate_artifacts.mjs';
import { resolveRunsDir } from './p2a_run_paths.mjs';
import {
  assertNoUninitializedScaffoldArtifactRoots,
  assertNotUninitializedScaffoldGraph,
  configuredTaskGraphPath,
  normalizePath,
  relativeToProject,
  resolveP2aPaths,
  singleArtifactProjectRoot,
} from './p2a_paths.mjs';
import {
  resolveIterationState,
  resolveTaskGraphSourceSpec,
} from './p2a_iteration_state.mjs';

const P2A_PATHS = resolveP2aPaths(import.meta.url);
const COMMANDS = new Set(['status', 'push', 'digest']);
const DEFAULT_MEMORY_URL_ENV = 'P2A_MEMORY_URL';
const DEFAULT_MEMORY_TOKEN_ENV = 'P2A_MEMORY_TOKEN';
const DEFAULT_ARTIFACT_LIMIT = 5000;
const MAX_CHUNK_CHARS = 2000;

function usage() {
  return [
    'Usage:',
    '  node .plan2agent/scripts/p2a_memory.mjs status (--artifacts <dir>|--graph <path>|--runs <dir>) [--server <url>] [--token <token>] [--json]',
    '  node .plan2agent/scripts/p2a_memory.mjs push (--artifacts <dir>|--graph <path>) [--server <url>] [--token <token>] [--dry-run] [--yes] [--json]',
    '  node .plan2agent/scripts/p2a_memory.mjs digest (--artifacts <dir>|--graph <path>|--runs <dir>) [--proposals <dir>] [--json]',
    '',
    'Commands:',
    '  status   Compare local project, iteration, document, task, run, and chunk snapshots with Memory.',
    '  push     Upsert local snapshots to Memory. Actual writes require --yes.',
    '  digest   Summarize failed/blocked runs, verification gaps, and proposal queue candidates.',
    '',
    'Source options:',
    '  --artifacts <dir>   Iterative artifact root, for example .plan2agent/artifacts/<project_id>.',
    '  --graph <path>      Task graph JSON path. Runs default beside the graph parent.',
    '  --runs <dir>        Explicit runs directory. Supported by status and digest only.',
    '  --proposals <dir>   Proposal queue directory for digest.',
    '',
    'Memory options:',
    `  --server <url>      Memory server base URL. Default: ${DEFAULT_MEMORY_URL_ENV} or project config memory.serverUrlEnv.`,
    `  --token <token>     X-P2A-Local-Token value. Default: ${DEFAULT_MEMORY_TOKEN_ENV} or project config memory.tokenEnv.`,
    '  --dry-run           For push, print the write plan without contacting the server.',
    '  --yes               Required for push to perform server writes.',
    '  --json              Machine-readable output.',
    '  --help, -h          Show this help.',
  ].join('\n');
}

function parseArgs(argv) {
  const command = argv[0];
  if (!command || command === '--help' || command === '-h') return { help: true };
  if (!COMMANDS.has(command)) throw new Error(`unknown command: ${command}\n\n${usage()}`);

  const args = {
    command,
    artifacts: null,
    graph: null,
    runs: null,
    proposals: null,
    server: null,
    token: null,
    dryRun: false,
    yes: false,
    json: false,
    help: false,
  };

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--artifacts') args.artifacts = requiredValue(argv, ++index, '--artifacts');
    else if (arg === '--graph') args.graph = requiredValue(argv, ++index, '--graph');
    else if (arg === '--runs') args.runs = requiredValue(argv, ++index, '--runs');
    else if (arg === '--proposals') args.proposals = requiredValue(argv, ++index, '--proposals');
    else if (arg === '--server') args.server = requiredValue(argv, ++index, '--server');
    else if (arg === '--token') args.token = requiredValue(argv, ++index, '--token');
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--yes') args.yes = true;
    else if (arg === '--json') args.json = true;
    else if (arg.startsWith('--')) throw new Error(`unknown option: ${arg}`);
    else throw new Error(`unexpected argument: ${arg}`);
  }

  if (args.help) return args;
  const sourceCount = [args.artifacts, args.graph, args.runs].filter(Boolean).length;
  if (sourceCount > 1) throw new Error('--artifacts, --graph, and --runs cannot be combined');
  if (args.command === 'push' && args.runs) throw new Error('push requires --artifacts or --graph; --runs is digest/status only');
  if (args.command !== 'push' && args.dryRun) throw new Error('--dry-run is only supported by push');
  if (args.command !== 'push' && args.yes) throw new Error('--yes is only supported by push');
  if (args.command !== 'digest' && args.proposals) throw new Error('--proposals is only supported by digest');

  if (sourceCount === 0) {
    const defaultArtifacts = singleArtifactProjectRoot();
    const configuredGraph = configuredTaskGraphPath();
    if (defaultArtifacts) args.artifacts = defaultArtifacts;
    else if (configuredGraph) args.graph = configuredGraph;
    else if (args.command === 'digest' && existsSync(path.join('.plan2agent', 'runs'))) args.runs = path.join('.plan2agent', 'runs');
    else assertNoUninitializedScaffoldArtifactRoots();
  }

  if (!args.artifacts && !args.graph && !args.runs) {
    throw new Error('--artifacts, --graph, or --runs is required');
  }
  if (args.command === 'push' && !args.artifacts && !args.graph) {
    throw new Error('push requires --artifacts or --graph');
  }
  if (args.graph) assertNotUninitializedScaffoldGraph(args.graph);
  return args;
}

function requiredValue(argv, index, optionName) {
  const value = argv[index];
  if (!value) throw new Error(`${optionName} requires a value`);
  return value;
}

function readJsonObject(filePath) {
  try {
    if (!existsSync(filePath) || !lstatSync(filePath).isFile()) return null;
    const data = JSON.parse(readFileSync(filePath, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

function projectConfig() {
  return readJsonObject(path.join(P2A_PATHS.projectRoot, '.plan2agent', 'project.config.json'));
}

function trimString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function resolveMemoryConnection(args) {
  const config = projectConfig();
  const memoryConfig = config?.memory && typeof config.memory === 'object' && !Array.isArray(config.memory)
    ? config.memory
    : {};
  const urlEnv = trimString(memoryConfig.serverUrlEnv) ?? DEFAULT_MEMORY_URL_ENV;
  const tokenEnv = trimString(memoryConfig.tokenEnv) ?? DEFAULT_MEMORY_TOKEN_ENV;
  const server = normalizeServerUrl(
    trimString(args.server)
      ?? trimString(process.env[urlEnv])
      ?? trimString(memoryConfig.serverUrl),
  );
  const token = trimString(args.token)
    ?? trimString(process.env[tokenEnv])
    ?? trimString(memoryConfig.token);
  return {
    server,
    token,
    serverSource: args.server ? 'arg' : process.env[urlEnv] ? `env:${urlEnv}` : memoryConfig.serverUrl ? 'project_config' : 'not_configured',
    tokenSource: token ? (args.token ? 'arg' : process.env[tokenEnv] ? `env:${tokenEnv}` : 'project_config') : 'not_configured',
  };
}

function normalizeServerUrl(value) {
  if (!value) return null;
  return value.replace(/\/+$/g, '');
}

function hashText(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stableHash(value, length = 16) {
  return hashText(typeof value === 'string' ? value : JSON.stringify(value)).slice(0, length);
}

function safeIdPart(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'item';
}

function stableId(prefix, parts) {
  return `${prefix}-${stableHash(parts)}`;
}

function fileExists(filePath) {
  try {
    return existsSync(filePath) && lstatSync(filePath).isFile();
  } catch {
    return false;
  }
}

function directoryExists(dirPath) {
  try {
    return existsSync(dirPath) && lstatSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function displayPath(filePath) {
  return relativeToProject(P2A_PATHS.projectRoot, filePath);
}

function sourceReference(canonicalServerId, filePath, fragment = null) {
  return {
    canonicalServerId,
    uri: pathToFileURL(filePath).href,
    path: displayPath(filePath),
    fragment,
  };
}

function metadata(values) {
  return Object.fromEntries(
    Object.entries(values)
      .filter(([, value]) => value !== null && value !== undefined && value !== '')
      .map(([key, value]) => [key, String(value)]),
  );
}

function sortedUnique(values) {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function sourceDocumentId(projectId, iterationId, sourcePath) {
  return `${projectId}:${iterationId}:${sourcePath}`;
}

function sourceTaskGraphId(projectId, iterationId, sourcePath) {
  return `${projectId}:${iterationId}:${sourcePath}`;
}

function readRuns(runsDir) {
  if (!directoryExists(runsDir)) return { runs: [], skippedRuns: [], totalRunRefs: 0 };
  const indexPath = path.join(runsDir, 'run-index.json');
  if (!fileExists(indexPath)) return { runs: [], skippedRuns: [], totalRunRefs: 0 };
  const index = validateRunIndexData(loadJson(indexPath));
  const runs = [];
  const skippedRuns = [];
  for (const entry of index.runs) {
    const runId = entry.runId;
    const runPath = path.join(runsDir, `${runId}.json`);
    try {
      if (!fileExists(runPath)) throw new Error(`run file is missing: ${runPath}`);
      const run = validateRunData(loadJson(runPath));
      runs.push({ run, filePath: runPath, raw: readFileSync(runPath, 'utf8') });
    } catch (error) {
      skippedRuns.push({ runId, reason: errorMessage(error) });
    }
  }
  return { runs, skippedRuns, totalRunRefs: index.runs.length };
}

function proposalFiles(proposalsDir) {
  if (!directoryExists(proposalsDir)) return [];
  return readdirSync(proposalsDir)
    .filter((entry) => entry.endsWith('.json'))
    .sort((left, right) => left.localeCompare(right))
    .map((entry) => path.join(proposalsDir, entry));
}

function readProposals(proposalsDir) {
  const proposals = [];
  const skippedProposals = [];
  for (const filePath of proposalFiles(proposalsDir)) {
    try {
      proposals.push(validateSkillProposal(filePath));
    } catch (error) {
      skippedProposals.push({ filePath, reason: errorMessage(error) });
    }
  }
  return { proposals, skippedProposals };
}

function defaultProposalsDir(args, runsDir, artifactRoot = null) {
  if (args.proposals) return path.resolve(args.proposals);
  if (artifactRoot) return path.join(artifactRoot, 'proposals');
  if (runsDir) return path.join(path.dirname(runsDir), 'proposals');
  return path.resolve('.plan2agent', 'proposals');
}

function graphSourceSpecPath(graph, graphPath) {
  const resolved = resolveTaskGraphSourceSpec(graph, graphPath);
  return resolved && fileExists(resolved) ? resolved : null;
}

function buildContext(args) {
  if (args.artifacts) return buildArtifactContext(args);
  if (args.graph) return buildGraphContext(args);
  return buildRunsOnlyContext(args);
}

function buildArtifactContext(args) {
  const state = resolveIterationState(args.artifacts, { requireReady: false });
  const graphPath = state.taskGraphPath;
  const hasGraph = fileExists(graphPath);
  const graph = hasGraph ? validateTaskGraph(graphPath) : null;
  const rawGraph = hasGraph ? readFileSync(graphPath, 'utf8') : null;
  const runsDir = resolveRunsDir({ artifacts: state.artifactRoot });
  const runs = readRuns(runsDir);
  const documentPaths = [
    state.statusPath,
    state.currentSpecPath,
    state.effectiveSpecPath,
    state.specPath,
    state.taskGraphPath,
    state.reviewPath,
  ].filter(fileExists);
  return {
    sourceKind: 'artifacts',
    sourcePath: state.artifactRoot,
    projectId: state.projectId,
    iterationId: state.activeIteration,
    iterationLabel: state.activeIteration,
    artifactRoot: state.artifactRoot,
    currentSpecPath: state.currentSpecPath,
    graphPath: hasGraph ? graphPath : null,
    graph,
    rawGraph,
    documentPaths,
    runsDir,
    runs,
    proposalsDir: defaultProposalsDir(args, runsDir, state.artifactRoot),
  };
}

function buildGraphContext(args) {
  const graphPath = path.resolve(args.graph);
  const graph = validateTaskGraph(graphPath);
  const rawGraph = readFileSync(graphPath, 'utf8');
  const specPath = graphSourceSpecPath(graph, graphPath);
  const runsDir = resolveRunsDir({ graph: graphPath });
  const runs = readRuns(runsDir);
  const iterationId = graph.version;
  return {
    sourceKind: 'graph',
    sourcePath: graphPath,
    projectId: graph.projectId,
    iterationId,
    iterationLabel: iterationId,
    artifactRoot: null,
    currentSpecPath: specPath ?? graphPath,
    graphPath,
    graph,
    rawGraph,
    documentPaths: [specPath, graphPath].filter(fileExists),
    runsDir,
    runs,
    proposalsDir: defaultProposalsDir(args, runsDir),
  };
}

function buildRunsOnlyContext(args) {
  const runsDir = path.resolve(args.runs);
  const runs = readRuns(runsDir);
  const firstRun = runs.runs[0]?.run;
  return {
    sourceKind: 'runs',
    sourcePath: runsDir,
    projectId: firstRun?.projectId ?? safeIdPart(path.basename(P2A_PATHS.projectRoot)),
    iterationId: firstRun?.iterationId ?? 'runs',
    iterationLabel: firstRun?.iterationId ?? 'runs',
    artifactRoot: null,
    currentSpecPath: runsDir,
    graphPath: null,
    graph: null,
    rawGraph: null,
    documentPaths: [],
    runsDir,
    runs,
    proposalsDir: defaultProposalsDir(args, runsDir),
  };
}

function buildMemoryPlan(args) {
  const context = buildContext(args);
  const projectId = context.projectId;
  const iterationId = context.iterationId ?? 'unknown';
  const projectCanonicalId = stableId('p2a-project', [projectId]);
  const iterationCanonicalId = stableId('p2a-iteration', [projectId, iterationId]);
  const baseMetadata = metadata({
    sourceProjectId: projectId,
    sourceIterationId: iterationId,
    p2aSourceKind: context.sourceKind,
  });

  const project = {
    id: projectCanonicalId,
    artifactType: 'PROJECT',
    sourceKey: projectId,
    request: {
      projectId: projectCanonicalId,
      sourceProjectId: projectId,
      name: projectId,
      canonicalServerId: projectCanonicalId,
      rootPath: P2A_PATHS.projectRoot,
      sourceReference: sourceReference(projectCanonicalId, P2A_PATHS.projectRoot, 'project-root'),
      metadata: baseMetadata,
    },
  };

  const iteration = {
    id: iterationCanonicalId,
    artifactType: 'ITERATION',
    sourceKey: iterationId,
    request: {
      iterationId: iterationCanonicalId,
      sourceIterationId: iterationId,
      label: context.iterationLabel ?? iterationId,
      status: 'ACTIVE',
      sourceReference: sourceReference(iterationCanonicalId, context.currentSpecPath ?? P2A_PATHS.projectRoot, 'iteration'),
      metadata: baseMetadata,
    },
  };

  const documents = buildDocumentSnapshots(context, projectCanonicalId, iterationCanonicalId, baseMetadata);
  const taskGraph = buildTaskGraphSnapshot(context, projectCanonicalId, iterationCanonicalId, documents, baseMetadata);
  const tasks = taskGraph ? buildTaskSnapshots(context, projectCanonicalId, iterationCanonicalId, taskGraph, baseMetadata) : [];
  const runs = buildRunSnapshots(context, projectCanonicalId, iterationCanonicalId, tasks, baseMetadata);
  const chunks = documents.flatMap((document) => document.chunks);
  const syncItems = [
    localItem(project.artifactType, project.id, project.sourceKey, null, project.request.metadata),
    localItem(iteration.artifactType, iteration.id, iteration.sourceKey, null, iteration.request.metadata),
    ...documents.map((document) => localItem('DOCUMENT_SNAPSHOT', document.id, document.sourceKey, document.contentHash, document.request.metadata, document.sourcePath)),
    ...(taskGraph ? [localItem('TASK_GRAPH', taskGraph.id, taskGraph.sourceKey, taskGraph.graphHash, taskGraph.request.metadata, taskGraph.sourcePath)] : []),
    ...tasks.map((task) => localItem('TASK', task.id, task.sourceKey, null, task.request.metadata)),
    ...runs.runs.map((run) => localItem('RUN_RECORD', run.id, run.sourceKey, run.contentHash, run.request.metadata, run.sourcePath)),
    ...chunks.map((chunk) => localItem('DOCUMENT_CHUNK', chunk.id, chunk.sourceKey, chunk.chunkHash, chunk.request.chunk.metadata, chunk.sourcePath)),
  ];

  return {
    schema_version: 'p2a.memory_plan.v1',
    generatedAt: new Date().toISOString(),
    context: {
      sourceKind: context.sourceKind,
      sourcePath: displayPath(context.sourcePath),
      projectId,
      iterationId,
      runsDir: context.runsDir ? displayPath(context.runsDir) : null,
      proposalsDir: context.proposalsDir ? displayPath(context.proposalsDir) : null,
    },
    project,
    iteration,
    documents,
    taskGraph,
    tasks,
    runs: runs.runs,
    skippedRuns: [...context.runs.skippedRuns, ...runs.skippedRuns],
    chunks,
    syncItems,
    summary: summarizePlan({ documents, chunks, taskGraph, tasks, runs: runs.runs, skippedRuns: [...context.runs.skippedRuns, ...runs.skippedRuns] }),
  };
}

function localItem(artifactType, artifactId, sourceKey, contentHash, sourceIds, sourcePath = null) {
  return {
    artifactType,
    artifactId,
    sourceKey,
    contentHash,
    sourcePath,
    sourceIds: {
      sourceProjectId: sourceIds.sourceProjectId ?? null,
      sourceIterationId: sourceIds.sourceIterationId ?? null,
      sourceDocumentId: sourceIds.sourceDocumentId ?? null,
      sourceTaskGraphId: sourceIds.sourceTaskGraphId ?? null,
      sourceTaskId: sourceIds.sourceTaskId ?? null,
      sourceRunId: sourceIds.sourceRunId ?? null,
      sourceChunkId: sourceIds.sourceChunkId ?? null,
    },
  };
}

function summarizePlan({ documents, chunks, taskGraph, tasks, runs, skippedRuns }) {
  return {
    projects: 1,
    iterations: 1,
    documents: documents.length,
    chunks: chunks.length,
    taskGraphs: taskGraph ? 1 : 0,
    tasks: tasks.length,
    runs: runs.length,
    skippedRuns: skippedRuns.length,
  };
}

function buildDocumentSnapshots(context, projectCanonicalId, iterationCanonicalId, baseMetadata) {
  const seen = new Set();
  return context.documentPaths
    .map((filePath) => path.resolve(filePath))
    .filter((filePath) => {
      if (seen.has(filePath)) return false;
      seen.add(filePath);
      return true;
    })
    .map((filePath) => {
      const content = readFileSync(filePath, 'utf8');
      if (!content.trim()) return null;
      const sourcePath = displayPath(filePath);
      const contentHash = hashText(content);
      const sourceId = sourceDocumentId(context.projectId, context.iterationId, sourcePath);
      const documentId = stableId('p2a-doc', [sourceId, contentHash]);
      const documentMetadata = metadata({
        ...baseMetadata,
        sourceDocumentId: sourceId,
        documentRole: documentRole(filePath),
      });
      const document = {
        id: documentId,
        sourceKey: sourceId,
        sourcePath,
        contentHash,
        content,
        request: {
          documentId,
          projectId: projectCanonicalId,
          iterationId: iterationCanonicalId,
          sourceDocumentId: sourceId,
          sourcePath,
          artifactType: 'DOCUMENT_SNAPSHOT',
          title: path.basename(filePath),
          content,
          contentHash,
          sourceReference: sourceReference(documentId, filePath),
          metadata: documentMetadata,
        },
        chunks: [],
      };
      document.chunks = buildDocumentChunks(document, projectCanonicalId, iterationCanonicalId);
      return document;
    })
    .filter(Boolean);
}

function documentRole(filePath) {
  const normalized = normalizePath(filePath);
  if (normalized.endsWith('/current-spec.json')) return 'current_spec';
  if (normalized.endsWith('/status.md')) return 'status';
  if (normalized.endsWith('/gate-b-spec/spec.json')) return 'spec';
  if (normalized.endsWith('/gate-c-task-graph/task-graph.json')) return 'task_graph_document';
  if (normalized.endsWith('/gate-d-review/review.json')) return 'review';
  return 'document';
}

function buildDocumentChunks(document, projectCanonicalId, iterationCanonicalId) {
  return chunkText(document.content).map((content, index) => {
    const chunkHash = hashText(`${index}\n${content}`);
    const chunkId = stableId('p2a-chunk', [document.id, index, chunkHash]);
    const sourceChunkId = `${document.sourceKey}:chunk-${index}`;
    return {
      id: chunkId,
      sourceKey: sourceChunkId,
      sourcePath: document.sourcePath,
      chunkHash,
      request: {
        chunk: {
          chunkId,
          projectId: projectCanonicalId,
          iterationId: iterationCanonicalId,
          artifactType: document.request.artifactType,
          sourcePath: document.sourcePath,
          chunkIndex: index,
          content,
          chunkHash,
          tokenEstimate: Math.ceil(content.length / 4),
          sourceReference: {
            ...document.request.sourceReference,
            canonicalServerId: chunkId,
            fragment: `chunk-${index}`,
          },
          metadata: metadata({
            ...document.request.metadata,
            sourceChunkId,
            parentDocumentId: document.id,
            chunkStrategy: `paragraph-${MAX_CHUNK_CHARS}`,
          }),
        },
      },
    };
  });
}

function chunkText(text) {
  const paragraphs = text.split(/\n{2,}/);
  const chunks = [];
  let current = '';
  for (const paragraph of paragraphs) {
    const normalized = paragraph.trim();
    if (!normalized) continue;
    if (normalized.length > MAX_CHUNK_CHARS) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      for (let offset = 0; offset < normalized.length; offset += MAX_CHUNK_CHARS) {
        chunks.push(normalized.slice(offset, offset + MAX_CHUNK_CHARS));
      }
      continue;
    }
    const next = current ? `${current}\n\n${normalized}` : normalized;
    if (next.length > MAX_CHUNK_CHARS && current) {
      chunks.push(current);
      current = normalized;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : [text.trim()];
}

function buildTaskGraphSnapshot(context, projectCanonicalId, iterationCanonicalId, documents, baseMetadata) {
  if (!context.graph || !context.graphPath) return null;
  const sourcePath = displayPath(context.graphPath);
  const graphHash = hashText(context.rawGraph);
  const sourceId = sourceTaskGraphId(context.projectId, context.iterationId, sourcePath);
  const taskGraphId = stableId('p2a-task-graph', [sourceId, graphHash]);
  const sourceDocument = documents.find((document) => document.sourcePath === sourcePath);
  const taskIdMap = new Map(context.graph.tasks.map((task) => [task.id, stableId('p2a-task', [sourceId, task.id])]));
  const dependencyEdges = context.graph.tasks.flatMap((task) =>
    task.dependencies.map((dependency) => ({
      fromTaskId: taskIdMap.get(dependency),
      toTaskId: taskIdMap.get(task.id),
    })),
  );
  return {
    id: taskGraphId,
    sourceKey: sourceId,
    sourcePath,
    graphHash,
    sourceTaskIdMap: taskIdMap,
    request: {
      taskGraphId,
      projectId: projectCanonicalId,
      iterationId: iterationCanonicalId,
      sourceTaskGraphId: sourceId,
      sourceDocumentId: sourceDocument?.request.sourceDocumentId ?? null,
      graphHash,
      graphJson: context.rawGraph,
      taskIds: [...taskIdMap.values()],
      dependencyEdges,
      sourceReference: sourceReference(taskGraphId, context.graphPath),
      metadata: metadata({
        ...baseMetadata,
        sourceTaskGraphId: sourceId,
        sourceDocumentId: sourceDocument?.request.sourceDocumentId ?? null,
        sourcePath,
      }),
    },
  };
}

function buildTaskSnapshots(context, projectCanonicalId, iterationCanonicalId, taskGraph, baseMetadata) {
  return context.graph.tasks.map((task) => {
    const taskId = taskGraph.sourceTaskIdMap.get(task.id);
    return {
      id: taskId,
      sourceKey: `${taskGraph.sourceKey}:${task.id}`,
      sourceTaskId: task.id,
      request: {
        taskId,
        projectId: projectCanonicalId,
        iterationId: iterationCanonicalId,
        taskGraphId: taskGraph.id,
        sourceTaskId: task.id,
        title: task.title,
        description: task.description,
        status: taskStatus(task.status),
        targetArea: task.targetArea,
        dependencies: task.dependencies.map((dependency) => taskGraph.sourceTaskIdMap.get(dependency)),
        acceptanceCriteria: task.acceptanceCriteria,
        sourceReference: sourceReference(taskId, context.graphPath, task.id),
        metadata: metadata({
          ...baseMetadata,
          sourceTaskGraphId: taskGraph.sourceKey,
          sourceTaskId: task.id,
          sourceSpecRefs: JSON.stringify(task.sourceSpecRefs),
          suggestedAgentPromptHash: stableHash(task.suggestedAgentPrompt ?? ''),
        }),
      },
    };
  });
}

function taskStatus(status) {
  const map = {
    todo: 'READY',
    blocked: 'BLOCKED',
    in_progress: 'IN_PROGRESS',
    done: 'DONE',
  };
  return map[status] ?? 'READY';
}

function memoryRunStatus(status) {
  const map = {
    started: 'STARTED',
    finished: 'FINISHED',
    failed: 'FAILED',
    blocked: 'BLOCKED',
  };
  return map[status] ?? 'STARTED';
}

function buildRunSnapshots(context, projectCanonicalId, iterationCanonicalId, tasks, baseMetadata) {
  const taskBySourceId = new Map(tasks.map((task) => [task.sourceTaskId, task]));
  const runs = [];
  const skippedRuns = [];
  for (const item of context.runs.runs) {
    const { run, filePath, raw } = item;
    const task = taskBySourceId.get(run.taskId);
    if (!task) {
      skippedRuns.push({
        runId: run.runId,
        reason: `run task ${run.taskId} is not in the selected task graph`,
      });
      continue;
    }
    const runId = stableId('p2a-run', [context.projectId, context.iterationId, run.runId]);
    const runMetadata = metadata({
      ...baseMetadata,
      sourceTaskId: run.taskId,
      sourceRunId: run.runId,
      taskTitle: run.taskTitle,
      failureClass: run.failure?.class ?? null,
      verificationCount: run.verification.length,
      changedFileCount: run.changedFiles.length,
    });
    runs.push({
      id: runId,
      sourceKey: `${run.taskId}:${run.runId}`,
      sourcePath: displayPath(filePath),
      contentHash: hashText(raw),
      request: {
        runId,
        projectId: projectCanonicalId,
        iterationId: iterationCanonicalId,
        taskId: task.id,
        sourceRunId: run.runId,
        status: memoryRunStatus(run.status),
        agentTool: run.agentTool,
        runJson: raw,
        artifactRefs: [],
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        sourceReference: sourceReference(runId, filePath),
        metadata: runMetadata,
      },
    });
  }
  return { runs, skippedRuns };
}

async function memoryGet(connection, pathName, searchParams = {}) {
  return memoryRequest(connection, 'GET', pathName, null, searchParams);
}

async function memoryPost(connection, pathName, body) {
  return memoryRequest(connection, 'POST', pathName, body);
}

async function memoryRequest(connection, method, pathName, body = null, searchParams = {}) {
  if (!connection.server) throw new Error('Memory server URL is not configured');
  const url = new URL(`/api${pathName}`, connection.server);
  for (const [key, value] of Object.entries(searchParams)) {
    if (value !== null && value !== undefined && value !== '') url.searchParams.set(key, String(value));
  }
  const headers = { Accept: 'application/json' };
  if (body !== null) headers['Content-Type'] = 'application/json';
  if (connection.token) headers['X-P2A-Local-Token'] = connection.token;
  const response = await fetch(url, {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!response.ok) {
    const detail = text ? `: ${text.slice(0, 500)}` : '';
    throw new Error(`${method} ${url.pathname} failed with ${response.status}${detail}`);
  }
  return parsed;
}

async function memoryHealth(connection) {
  if (!connection.server) {
    return { status: 'not_configured', detail: null };
  }
  try {
    const health = await memoryGet(connection, '/health');
    return { status: health?.status === 'UP' ? 'up' : 'unknown', detail: health };
  } catch (error) {
    return { status: 'unavailable', detail: errorMessage(error) };
  }
}

async function fetchRemoteArtifacts(connection, plan) {
  if (!connection.server) return { artifacts: [], error: null };
  try {
    const artifacts = await memoryGet(connection, '/artifacts', {
      sourceProjectId: plan.context.projectId,
      limit: DEFAULT_ARTIFACT_LIMIT,
    });
    return { artifacts: Array.isArray(artifacts) ? artifacts : [], error: null };
  } catch (error) {
    return { artifacts: [], error: errorMessage(error) };
  }
}

function remoteKey(item) {
  const sourceIds = item.sourceIds ?? {};
  if (item.artifactType === 'PROJECT') return sourceIds.sourceProjectId ?? item.metadata?.sourceProjectId ?? item.artifactId;
  if (item.artifactType === 'ITERATION') return sourceIds.sourceIterationId ?? item.metadata?.sourceIterationId ?? item.artifactId;
  if (item.artifactType === 'DOCUMENT_SNAPSHOT') return sourceIds.sourceDocumentId ?? item.sourcePath ?? item.artifactId;
  if (item.artifactType === 'TASK_GRAPH') return sourceIds.sourceTaskGraphId ?? item.artifactId;
  if (item.artifactType === 'TASK') return `${sourceIds.sourceTaskGraphId ?? ''}:${sourceIds.sourceTaskId ?? item.taskId ?? item.artifactId}`;
  if (item.artifactType === 'RUN_RECORD') return `${sourceIds.sourceTaskId ?? ''}:${sourceIds.sourceRunId ?? item.runId ?? item.artifactId}`;
  if (item.artifactType === 'DOCUMENT_CHUNK') return sourceIds.sourceChunkId ?? item.artifactId;
  return item.artifactId;
}

function localKey(item) {
  if (item.artifactType === 'TASK') return `${item.sourceIds.sourceTaskGraphId ?? ''}:${item.sourceIds.sourceTaskId}`;
  if (item.artifactType === 'RUN_RECORD') return `${item.sourceIds.sourceTaskId ?? ''}:${item.sourceIds.sourceRunId}`;
  if (item.artifactType === 'PROJECT') return item.sourceIds.sourceProjectId ?? item.sourceKey;
  if (item.artifactType === 'ITERATION') return item.sourceIds.sourceIterationId ?? item.sourceKey;
  if (item.artifactType === 'DOCUMENT_SNAPSHOT') return item.sourceIds.sourceDocumentId ?? item.sourcePath;
  if (item.artifactType === 'TASK_GRAPH') return item.sourceIds.sourceTaskGraphId ?? item.sourceKey;
  if (item.artifactType === 'DOCUMENT_CHUNK') return item.sourceIds.sourceChunkId ?? item.sourceKey;
  return item.sourceKey ?? item.artifactId;
}

function compareSync(plan, remoteArtifacts) {
  const remoteByKey = new Map();
  for (const item of remoteArtifacts) {
    remoteByKey.set(`${item.artifactType}:${remoteKey(item)}`, item);
  }
  const items = plan.syncItems.map((item) => {
    const key = `${item.artifactType}:${localKey(item)}`;
    const remote = remoteByKey.get(key) ?? null;
    if (!remote) return { ...item, syncStatus: 'missing_remote', remote: null };
    if (item.contentHash && remote.contentHash && item.contentHash !== remote.contentHash) {
      return { ...item, syncStatus: 'remote_differs', remoteArtifactId: remote.artifactId, remoteContentHash: remote.contentHash };
    }
    return { ...item, syncStatus: 'synced', remoteArtifactId: remote.artifactId, remoteContentHash: remote.contentHash ?? null };
  });
  const matchedKeys = new Set(items.filter((item) => item.remoteArtifactId).map((item) => `${item.artifactType}:${localKey(item)}`));
  const extraRemote = remoteArtifacts.filter((item) => !matchedKeys.has(`${item.artifactType}:${remoteKey(item)}`));
  const summary = {
    totalLocal: items.length,
    synced: items.filter((item) => item.syncStatus === 'synced').length,
    missingRemote: items.filter((item) => item.syncStatus === 'missing_remote').length,
    remoteDiffers: items.filter((item) => item.syncStatus === 'remote_differs').length,
    extraRemote: extraRemote.length,
  };
  return { summary, items, extraRemote };
}

async function runStatus(args) {
  const plan = buildMemoryPlan(args);
  const connection = resolveMemoryConnection(args);
  const server = await memoryHealth(connection);
  const remote = await fetchRemoteArtifacts(connection, plan);
  const sync = compareSync(plan, remote.artifacts);
  const payload = {
    schema_version: 'p2a.memory_status.v1',
    generatedAt: new Date().toISOString(),
    context: plan.context,
    server: {
      url: connection.server,
      source: connection.serverSource,
      status: remote.error ? 'unavailable' : server.status,
      detail: remote.error ?? server.detail,
    },
    local: plan.summary,
    sync,
    skippedRuns: plan.skippedRuns,
    nextActions: statusNextActions(connection, sync, plan),
  };
  if (args.json) console.log(JSON.stringify(payload, null, 2));
  else printStatus(payload);
  return 0;
}

function statusNextActions(connection, sync, plan) {
  const actions = [];
  if (!connection.server) actions.push(`Set ${DEFAULT_MEMORY_URL_ENV} or pass --server to compare with Memory.`);
  if (sync.summary.missingRemote > 0) {
    if (plan.context.sourceKind === 'graph' || plan.context.sourceKind === 'artifacts') {
      actions.push(`Preview push: node .plan2agent/scripts/p2a_memory.mjs push --${plan.context.sourceKind === 'graph' ? 'graph' : 'artifacts'} ${plan.context.sourcePath} --dry-run`);
    } else {
      actions.push('Use --artifacts or --graph when you are ready to push full project/task snapshots to Memory.');
    }
  }
  if (plan.skippedRuns.length > 0) actions.push('Inspect skipped run records before relying on Memory run coverage.');
  return actions;
}

function printStatus(payload) {
  console.log('Plan2Agent memory status');
  console.log(`- project: ${payload.context.projectId}`);
  console.log(`- iteration: ${payload.context.iterationId}`);
  console.log(`- source: ${payload.context.sourceKind} ${payload.context.sourcePath}`);
  console.log(`- server: ${payload.server.status}${payload.server.url ? ` (${payload.server.url})` : ''}`);
  console.log(`- local: ${formatSummary(payload.local)}`);
  console.log(`- sync: synced=${payload.sync.summary.synced} missingRemote=${payload.sync.summary.missingRemote} remoteDiffers=${payload.sync.summary.remoteDiffers} extraRemote=${payload.sync.summary.extraRemote}`);
  if (payload.skippedRuns.length) console.log(`- skipped runs: ${payload.skippedRuns.length}`);
  if (payload.nextActions.length) {
    console.log('next actions:');
    payload.nextActions.forEach((action) => console.log(`- ${action}`));
  }
}

function formatSummary(summary) {
  return [
    `projects=${summary.projects}`,
    `iterations=${summary.iterations}`,
    `documents=${summary.documents}`,
    `chunks=${summary.chunks}`,
    `taskGraphs=${summary.taskGraphs}`,
    `tasks=${summary.tasks}`,
    `runs=${summary.runs}`,
    `skippedRuns=${summary.skippedRuns}`,
  ].join(' ');
}

async function runPush(args) {
  const plan = buildMemoryPlan(args);
  const connection = resolveMemoryConnection(args);
  const dryRun = args.dryRun || !args.yes;
  if (dryRun) {
    const payload = {
      schema_version: 'p2a.memory_push_preview.v1',
      generatedAt: new Date().toISOString(),
      dryRun: true,
      approvalRequired: !args.yes,
      context: plan.context,
      server: {
        url: connection.server,
        source: connection.serverSource,
      },
      local: plan.summary,
      skippedRuns: plan.skippedRuns,
      writeOrder: writeOrder(plan),
      nextActions: pushPreviewNextActions(args, connection, plan),
    };
    if (args.json) console.log(JSON.stringify(payload, null, 2));
    else printPushPreview(payload);
    return args.dryRun ? 0 : 1;
  }

  if (!connection.server) throw new Error(`Memory server URL is required for push. Set ${DEFAULT_MEMORY_URL_ENV} or pass --server.`);
  const result = await pushPlan(connection, plan);
  const payload = {
    schema_version: 'p2a.memory_push_result.v1',
    generatedAt: new Date().toISOString(),
    context: plan.context,
    server: {
      url: connection.server,
      source: connection.serverSource,
    },
    local: plan.summary,
    skippedRuns: plan.skippedRuns,
    result,
  };
  if (args.json) console.log(JSON.stringify(payload, null, 2));
  else printPushResult(payload);
  return 0;
}

function writeOrder(plan) {
  return [
    { artifactType: 'PROJECT', count: 1 },
    { artifactType: 'ITERATION', count: 1 },
    { artifactType: 'DOCUMENT_SNAPSHOT', count: plan.documents.length },
    { artifactType: 'TASK_GRAPH', count: plan.taskGraph ? 1 : 0 },
    { artifactType: 'TASK', count: plan.tasks.length },
    { artifactType: 'RUN_RECORD', count: plan.runs.length },
    { artifactType: 'DOCUMENT_CHUNK', count: plan.chunks.length },
  ];
}

function pushPreviewNextActions(args, connection, plan) {
  const actions = [];
  if (!connection.server) actions.push(`Set ${DEFAULT_MEMORY_URL_ENV} or pass --server before actual push.`);
  if (!args.yes) actions.push('Actual Memory writes require --yes.');
  if (plan.skippedRuns.length) actions.push('Resolve skipped runs if they should be stored in Memory.');
  return actions;
}

function printPushPreview(payload) {
  console.log('Plan2Agent memory push dry run');
  console.log(`- project: ${payload.context.projectId}`);
  console.log(`- iteration: ${payload.context.iterationId}`);
  console.log(`- server: ${payload.server.url ?? 'not_configured'}`);
  console.log('- dry-run: no server writes');
  console.log(`- local: ${formatSummary(payload.local)}`);
  console.log('- write order:');
  payload.writeOrder.forEach((item) => console.log(`  - ${item.artifactType}: ${item.count}`));
  if (payload.nextActions.length) {
    console.log('next actions:');
    payload.nextActions.forEach((action) => console.log(`- ${action}`));
  }
}

async function pushPlan(connection, plan) {
  const result = {
    project: null,
    iteration: null,
    documents: [],
    taskGraph: null,
    tasks: [],
    runs: [],
    chunks: [],
  };
  result.project = await memoryPost(connection, '/projects', plan.project.request);
  result.iteration = await memoryPost(connection, `/projects/${encodeURIComponent(plan.project.id)}/iterations`, plan.iteration.request);
  for (const document of plan.documents) {
    const response = await memoryPost(connection, '/documents/snapshots', document.request);
    result.documents.push(response);
    if (document.chunks.length) {
      const chunkResponse = await memoryPost(connection, '/document-chunks/bulk', {
        documentId: response.documentId,
        chunks: document.chunks.map((chunk) => chunk.request),
      });
      result.chunks.push(...chunkResponse);
    }
  }
  if (plan.taskGraph) {
    result.taskGraph = await memoryPost(connection, '/task-graphs', plan.taskGraph.request);
  }
  if (plan.tasks.length) {
    result.tasks = await memoryPost(connection, '/tasks/bulk', {
      graphId: plan.taskGraph.id,
      tasks: plan.tasks.map((task) => task.request),
    });
  }
  for (const run of plan.runs) {
    result.runs.push(await memoryPost(connection, '/runs', run.request));
  }
  return {
    projectId: result.project?.projectId ?? null,
    iterationId: result.iteration?.iterationId ?? null,
    documents: result.documents.length,
    taskGraphId: result.taskGraph?.taskGraphId ?? null,
    tasks: result.tasks.length,
    runs: result.runs.length,
    chunks: result.chunks.length,
  };
}

function printPushResult(payload) {
  console.log('Plan2Agent memory push');
  console.log(`- project: ${payload.context.projectId}`);
  console.log(`- iteration: ${payload.context.iterationId}`);
  console.log(`- server: ${payload.server.url}`);
  console.log(`- wrote: documents=${payload.result.documents} chunks=${payload.result.chunks} taskGraph=${payload.result.taskGraphId ? 1 : 0} tasks=${payload.result.tasks} runs=${payload.result.runs}`);
  if (payload.skippedRuns.length) console.log(`- skipped runs: ${payload.skippedRuns.length}`);
}

async function runDigest(args) {
  const context = buildContext(args);
  const { proposals, skippedProposals } = readProposals(context.proposalsDir);
  const runs = context.runs.runs.map((item) => item.run);
  const digest = buildDigest(context, runs, context.runs.skippedRuns, proposals, skippedProposals);
  if (args.json) console.log(JSON.stringify(digest, null, 2));
  else printDigest(digest);
  return 0;
}

function buildDigest(context, runs, skippedRuns, proposals, skippedProposals) {
  const failedRuns = runs.filter((run) => ['failed', 'blocked'].includes(run.status));
  const verificationFailures = runs.filter((run) => run.verification.some((item) => item.status === 'failed'));
  const verificationGaps = runs.filter((run) => run.status === 'finished' && run.verification.length === 0);
  const failedByClass = {};
  for (const run of failedRuns) {
    const failureClass = run.failure?.class ?? 'unknown';
    failedByClass[failureClass] = (failedByClass[failureClass] ?? 0) + 1;
  }
  const proposalsByStatus = {};
  const proposalsByRisk = {};
  const proposalSourceRuns = new Set();
  for (const proposal of proposals) {
    proposalsByStatus[proposal.status] = (proposalsByStatus[proposal.status] ?? 0) + 1;
    proposalsByRisk[proposal.risk] = (proposalsByRisk[proposal.risk] ?? 0) + 1;
    if (proposal.sourceRunId) proposalSourceRuns.add(proposal.sourceRunId);
  }
  const proposalCandidateRuns = sortedUnique([
    ...failedRuns.map((run) => run.runId),
    ...verificationGaps.map((run) => run.runId),
  ]);
  const uncoveredCandidateRuns = proposalCandidateRuns.filter((runId) => !proposalSourceRuns.has(runId));
  const maintenanceCandidates = proposals
    .filter((proposal) => proposal.status === 'proposed')
    .sort((left, right) => riskRank(left.risk) - riskRank(right.risk) || left.proposalId.localeCompare(right.proposalId))
    .slice(0, 10)
    .map((proposal) => ({
      proposalId: proposal.proposalId,
      risk: proposal.risk,
      sourceRunId: proposal.sourceRunId ?? null,
      problem: proposal.problem,
    }));
  return {
    schema_version: 'p2a.memory_digest.v1',
    generatedAt: new Date().toISOString(),
    context: {
      sourceKind: context.sourceKind,
      sourcePath: displayPath(context.sourcePath),
      projectId: context.projectId,
      iterationId: context.iterationId,
      runsDir: context.runsDir ? displayPath(context.runsDir) : null,
      proposalsDir: context.proposalsDir ? displayPath(context.proposalsDir) : null,
    },
    runs: {
      total: runs.length,
      failedOrBlocked: failedRuns.length,
      failedByClass,
      verificationFailures: verificationFailures.length,
      verificationGaps: verificationGaps.length,
      skippedRuns: skippedRuns.length,
    },
    proposals: {
      total: proposals.length,
      byStatus: proposalsByStatus,
      byRisk: proposalsByRisk,
      skippedProposals: skippedProposals.length,
      candidateRuns: proposalCandidateRuns.length,
      uncoveredCandidateRuns,
    },
    maintenanceCandidates,
    nextActions: digestNextActions(context, uncoveredCandidateRuns, proposals),
    skippedRuns,
    skippedProposals,
  };
}

function riskRank(risk) {
  return { high: 0, medium: 1, low: 2 }[risk] ?? 9;
}

function digestNextActions(context, uncoveredCandidateRuns, proposals) {
  const sourceFlag = context.sourceKind === 'artifacts'
    ? `--artifacts ${displayPath(context.sourcePath)}`
    : context.sourceKind === 'graph'
      ? `--graph ${displayPath(context.sourcePath)}`
      : `--runs ${displayPath(context.runsDir)}`;
  const actions = [];
  if (uncoveredCandidateRuns.length || proposals.some((proposal) => proposal.status === 'proposed')) {
    actions.push(`Analyze failure clusters: node .plan2agent/scripts/p2a_eval.mjs analyze ${sourceFlag}`);
  }
  if (uncoveredCandidateRuns.length) {
    actions.push(`Mine missing proposal candidates: node .plan2agent/scripts/p2a_proposals.mjs mine ${sourceFlag}`);
  }
  if (proposals.some((proposal) => proposal.status === 'proposed')) {
    actions.push(`Review proposal queue: node .plan2agent/scripts/p2a_proposals.mjs review --proposals ${displayPath(context.proposalsDir)} --dry-run`);
    actions.push(`Curate approved maintenance candidates after review: node .plan2agent/scripts/p2a_proposals.mjs curate --review <review.json> --proposals ${displayPath(context.proposalsDir)} --dry-run`);
  }
  if (!actions.length) actions.push('No immediate maintenance proposal action found from local run/proposal evidence.');
  return actions;
}

function printDigest(payload) {
  console.log('Plan2Agent memory digest');
  console.log(`- project: ${payload.context.projectId}`);
  console.log(`- iteration: ${payload.context.iterationId}`);
  console.log(`- runs: total=${payload.runs.total} failedOrBlocked=${payload.runs.failedOrBlocked} verificationFailures=${payload.runs.verificationFailures} verificationGaps=${payload.runs.verificationGaps} skipped=${payload.runs.skippedRuns}`);
  const classes = Object.entries(payload.runs.failedByClass);
  if (classes.length) console.log(`- failure classes: ${classes.map(([name, count]) => `${name}=${count}`).join(' ')}`);
  console.log(`- proposals: total=${payload.proposals.total} proposed=${payload.proposals.byStatus.proposed ?? 0} candidateRuns=${payload.proposals.candidateRuns} uncoveredCandidateRuns=${payload.proposals.uncoveredCandidateRuns.length}`);
  if (payload.maintenanceCandidates.length) {
    console.log('maintenance candidates:');
    payload.maintenanceCandidates.forEach((candidate) => {
      console.log(`- ${candidate.proposalId} risk=${candidate.risk} sourceRun=${candidate.sourceRunId ?? 'none'}`);
    });
  }
  if (payload.nextActions.length) {
    console.log('next actions:');
    payload.nextActions.forEach((action) => console.log(`- ${action}`));
  }
}

function errorMessage(error) {
  return error instanceof Error && error.message ? error.message : String(error);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return 0;
  }
  if (args.command === 'status') return runStatus(args);
  if (args.command === 'push') return runPush(args);
  if (args.command === 'digest') return runDigest(args);
  throw new Error(`unknown command: ${args.command}`);
}

main()
  .then((status) => {
    process.exitCode = status;
  })
  .catch((error) => {
    console.error(`p2a_memory error: ${errorMessage(error)}`);
    process.exitCode = 1;
  });
