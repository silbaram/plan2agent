#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { aggregateAbRuns as baseAggregate } from '../../../../../scripts/p2a_ab_metrics.mjs';
import { SanitizedAgyToolTrace } from '../../../../../scripts/p2a_agy_tool_trace.mjs';
import { evaluateRuntimeRoutingPerformance } from '../../../../../scripts/p2a_runtime_performance_gate.mjs';
import {
  gradeRuntimeRoutingResult,
  loadRuntimeEvaluationContract,
  runtimeEvaluationSourceManifest,
  stableJson,
} from '../../../../../scripts/p2a_runtime_eval_core.mjs';
export {
  isScopeOverlappingCanonical,
  SanitizedAgyToolTrace,
} from '../../../../../scripts/p2a_agy_tool_trace.mjs';
import { buildRuntimeContextFixture } from '../../../../../scripts/p2a_runtime_context_fixture.mjs';

export const gradeResult = gradeRuntimeRoutingResult;
export const loadEvaluationContract = loadRuntimeEvaluationContract;
export const sourceManifest = runtimeEvaluationSourceManifest;

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '../../../../..');
const DEFAULT_CONTRACT = path.join(SCRIPT_DIR, 'contract.gemini-runtime-routing.json');
const DEFAULT_SCHEMA = path.join(PROJECT_ROOT, 'plans/evidence/context-engineering/CE-009/codex/result.schema.json');
const DEFAULT_OUTPUT = path.join(PROJECT_ROOT, 'plans/evidence/context-engineering/CE-012-gemini-runtime-routing-ab/agy');
const DEFAULT_EVALUATION_ID = 'ce-012-gemini-runtime-routing-2026-08-16';
function fail(message) {
  throw new Error(message);
}

function requiredValue(argv, index, label) {
  const value = argv[index];
  if (!value || value.startsWith('--')) fail(`${label} requires a value`);
  return value;
}

function parsePositiveInteger(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) fail(`${label} must be a positive integer`);
  return parsed;
}

export function parseArgs(argv) {
  const args = {
    baseline: PROJECT_ROOT,
    candidate: PROJECT_ROOT,
    contract: DEFAULT_CONTRACT,
    schema: DEFAULT_SCHEMA,
    output: DEFAULT_OUTPUT,
    model: 'gemini-3.7-flash-medium',
    repetitions: 5,
    scenarios: ['gate-b-spec', 'direct-execution', 'planned-retry'],
    evaluationId: DEFAULT_EVALUATION_ID,
    preflightOnly: false,
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--baseline') args.baseline = path.resolve(requiredValue(argv, ++index, arg));
    else if (arg === '--candidate') args.candidate = path.resolve(requiredValue(argv, ++index, arg));
    else if (arg === '--contract') args.contract = path.resolve(requiredValue(argv, ++index, arg));
    else if (arg === '--schema') args.schema = path.resolve(requiredValue(argv, ++index, arg));
    else if (arg === '--output') args.output = path.resolve(requiredValue(argv, ++index, arg));
    else if (arg === '--model') args.model = requiredValue(argv, ++index, arg);
    else if (arg === '--repetitions') args.repetitions = parsePositiveInteger(requiredValue(argv, ++index, arg), arg);
    else if (arg === '--scenario') {
      if (args.scenarios.length === 3 && args.scenarios[0] === 'gate-b-spec') args.scenarios = [];
      args.scenarios.push(requiredValue(argv, ++index, arg));
    }
    else if (arg === '--evaluation-id') args.evaluationId = requiredValue(argv, ++index, arg);
    else if (arg === '--preflight-only') args.preflightOnly = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--help' || arg === '-h') {
      console.log([
        'Usage:',
        '  node run-agy-ab.mjs [options]',
        '',
        'Options:',
        '  --model <slug>          Default: gemini-3.7-flash-medium',
        '  --repetitions <n>       Default: 5',
        '  --scenario <id>         Select a scenario; repeat to select several',
        '  --contract <file>       Contract overlay or base contract',
        '  --schema <file>         JSON schema file for output',
        '  --output <dir>          Default: .../CE-012-gemini-runtime-routing-ab/agy',
        '  --evaluation-id <id>    Default: ce-012-gemini-runtime-routing-2026-08-16',
        '  --preflight-only        Run only preflight validation',
        '  --dry-run               Validate and print matrix without model calls',
      ].join('\n'));
      process.exit(0);
    } else fail(`unknown option: ${arg}`);
  }
  return args;
}

export function validateOutputDir(outputDir) {
  const normalized = path.resolve(outputDir);
  if (normalized.includes('CE-011-gemini-runtime-routing-ab')) {
    fail(`Output directory cannot target existing CE-011 evidence: ${outputDir}`);
  }
  if (existsSync(outputDir)) {
    const summaryFile = path.join(outputDir, 'gemini-ab-summary.json');
    const preflightFile = path.join(outputDir, 'preflight-summary.json');
    if (existsSync(summaryFile) || existsSync(preflightFile)) {
      fail(`Output directory already contains existing evaluation evidence: ${outputDir}`);
    }
  }
}

function readJson(filePath, label) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    fail(`${label} is unreadable: ${error.message}`);
  }
}

function parseJsonFile(filePath) {
  try {
    return { value: JSON.parse(readFileSync(filePath, 'utf8')), error: null };
  } catch (error) {
    return { value: null, error: error.message };
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizePath(value) {
  return String(value).replaceAll(path.sep, '/');
}

export function validateAndCleanSnapshot(targetDir) {
  if (!targetDir || typeof targetDir !== 'string') {
    fail('Invalid snapshot target directory');
  }
  const resolvedTarget = path.resolve(targetDir);
  if (!existsSync(resolvedTarget)) {
    fail(`Snapshot cleanup aborted: ${resolvedTarget} does not exist`);
  }
  const realTarget = realpathSync(resolvedTarget);
  const sysTmp = os.tmpdir();
  const realTmpDir = realpathSync(sysTmp);

  // Boundary check using realTmpDir + path.sep
  const tmpPrefix = realTmpDir.endsWith(path.sep) ? realTmpDir : `${realTmpDir}${path.sep}`;
  if (!realTarget.startsWith(tmpPrefix)) {
    fail(`Snapshot cleanup aborted: ${realTarget} is not inside tmpdir (${tmpPrefix})`);
  }

  const baseName = path.basename(realTarget);
  if (!baseName.startsWith('p2a-gemini-')) {
    fail(`Snapshot cleanup aborted: ${baseName} does not have prefix 'p2a-gemini-'`);
  }

  const lstat = lstatSync(resolvedTarget);
  if (lstat.isSymbolicLink()) {
    fail(`Snapshot cleanup aborted: ${resolvedTarget} is a symbolic link`);
  }
  if (!lstat.isDirectory()) {
    fail(`Snapshot cleanup aborted: ${resolvedTarget} is not a directory`);
  }

  rmSync(realTarget, { recursive: true });
}

export function createIsolatedSourceSnapshot(sourceRoot, label = 'snapshot') {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), `p2a-gemini-${label}-`));
  const realTmpDir = realpathSync(tmpDir);
  const ignoredNames = new Set(['.git', 'node_modules', '.agents_cache']);

  function copyFiltered(currentSrc, currentDest, relative) {
    mkdirSync(currentDest, { recursive: true });
    const entries = readdirSync(currentSrc, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (ignoredNames.has(entry.name)) continue;
      const nextRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (nextRelative.startsWith('plans/evidence')) continue;
      const srcPath = path.join(currentSrc, entry.name);
      const destPath = path.join(currentDest, entry.name);
      if (entry.isDirectory()) {
        copyFiltered(srcPath, destPath, nextRelative);
      } else if (entry.isFile()) {
        cpSync(srcPath, destPath);
      }
    }
  }

  try {
    copyFiltered(sourceRoot, realTmpDir, '');
  } catch (copyError) {
    validateAndCleanSnapshot(realTmpDir);
    throw copyError;
  }

  const manifest = sourceManifest(realTmpDir);
  return {
    path: realTmpDir,
    manifest,
    cleanup: () => validateAndCleanSnapshot(realTmpDir),
  };
}

function promptFor(scenario, workspaceRoot, runtimeContext = null) {
  const lines = [
    'You are one isolated evaluation subject for Plan2Agent context engineering.',
    'Work read-only. Do not modify files, access paths outside this workspace, use network access, or ask the user questions.',
    'Read every primary skill listed below in full using view_file. Follow its own routing instructions and load additional references only when the case meets their stated condition.',
  ];
  if (runtimeContext) {
    lines.push(
      'The host already resolved the runtime context packet below. Use it directly; do not call p2a context show or reopen packet-managed source paths.',
    );
  }
  lines.push(
    'Judge the synthetic case using the repository version in this workspace.',
    'Return only the JSON object required by the supplied output schema.',
    'Use only the stable snake_case identifiers already present in the case or infer the exact identifiers implied by the instruction. Do not add speculative questions.',
    '',
    `Scenario id: ${scenario.id}`,
    `Workspace root: ${workspaceRoot}`,
    `Primary skills: ${scenario.primary_skills.map((p) => (path.isAbsolute(p) ? p : path.resolve(workspaceRoot, p))).join(', ')}`,
    `Case JSON: ${JSON.stringify(scenario.case)}`,
  );
  if (runtimeContext) lines.push('', runtimeContext.modelPacket.trimEnd());
  return lines.join('\n');
}

export function traceSourceAllowlist(sourceRoot, scenario) {
  const entries = [];
  const add = (id, relativePaths) => {
    const paths = relativePaths.flatMap((relativePath) => [
      relativePath,
      path.resolve(sourceRoot, relativePath),
    ]);
    entries.push({ id, paths });
  };
  for (const primarySkill of scenario.primary_skills ?? []) {
    const normalized = primarySkill.replaceAll(path.sep, '/');
    const parts = normalized.split('/');
    const skillIndex = parts.lastIndexOf('skills');
    const skillId = skillIndex >= 0 ? parts[skillIndex + 1] : path.basename(path.dirname(normalized));
    add(`skill:${skillId}`, [normalized]);
  }
  const routes = parseJsonFile(path.join(sourceRoot, '.agents', 'context-routes.json')).value;
  for (const skill of routes?.skills ?? []) {
    for (const reference of skill.references ?? []) {
      if (typeof reference.path !== 'string') continue;
      const sourceId = typeof reference.id === 'string'
        ? reference.id
        : `reference:${skill.id}:${reference.path}`;
      add(sourceId, [
        path.posix.join('.agents', 'skills', skill.id, reference.path),
        ...(reference.provider_paths ?? [])
          .filter((item) => ['gemini', 'codex'].includes(item?.provider) && typeof item.path === 'string')
          .map((item) => path.posix.join('.agents', 'skills', skill.id, item.path)),
      ]);
    }
  }
  return entries;
}

function runAgy({ cwd, model, schemaPath, prompt, sourceAllowlist }) {
  return new Promise((resolve) => {
    const startedAt = new Date();
    const stdoutHash = createHash('sha256');
    const stderrHash = createHash('sha256');
    const eventCounts = {};
    let finalUsage = {};
    let stdoutBuffer = '';
    let toolCalls = 0;
    let toolFailures = 0;
    let finalResponse = null;
    let durationSeconds = null;
    const toolTrace = new SanitizedAgyToolTrace(sourceAllowlist, { workspaceRoot: cwd });
    let settled = false;

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      resolve(payload);
    };

    const args = [
      '--print',
      prompt,
      '--model',
      model,
      '--mode',
      'plan',
      '--sandbox',
      '--output-format',
      'stream-json',
      '--json-schema',
      schemaPath,
      '--disable-slash-commands',
    ];

    const child = spawn('agy', args, {
      cwd,
      env: {
        ...process.env,
        PATH: process.env.PATH,
        HOME: process.env.HOME,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const processEvent = (event) => {
      const type = event?.event ?? event?.type ?? 'unknown';
      eventCounts[type] = (eventCounts[type] ?? 0) + 1;

      if (event?.event === 'step_update' && event.step_update) {
        const su = event.step_update;
        if (su.usage) {
          finalUsage = {
            input_tokens: su.usage.input_tokens ?? finalUsage.input_tokens ?? 0,
            cached_input_tokens: su.usage.cache_read_tokens ?? finalUsage.cached_input_tokens ?? 0,
            output_tokens: su.usage.output_tokens ?? finalUsage.output_tokens ?? 0,
            thinking_tokens: su.usage.thinking_tokens ?? finalUsage.thinking_tokens ?? 0,
            total_tokens: su.usage.total_tokens ?? finalUsage.total_tokens ?? 0,
          };
        }
        if (su.step_type === 'tool' && su.state === 'DONE') {
          toolCalls += 1;
          const isError = su.tool_info?.error != null;
          if (isError) toolFailures += 1;
          toolTrace.observeTool(su.tool_name, su.tool_info?.parameters, isError, {
            matchedFiles: su.tool_info?.matched_files ?? su.tool_info?.files ?? null,
          });
        } else if (su.step_type === 'tool' && su.state === 'ERROR') {
          toolCalls += 1;
          toolFailures += 1;
          toolTrace.observeTool(su.tool_name, su.tool_info?.parameters, true);
        }
      }

      if (event?.event === 'result' && event.result) {
        const res = event.result;
        if (res.usage) {
          finalUsage = {
            input_tokens: res.usage.input_tokens ?? finalUsage.input_tokens ?? 0,
            cached_input_tokens: res.usage.cache_read_tokens ?? finalUsage.cached_input_tokens ?? 0,
            output_tokens: res.usage.output_tokens ?? finalUsage.output_tokens ?? 0,
            thinking_tokens: res.usage.thinking_tokens ?? finalUsage.thinking_tokens ?? 0,
            total_tokens: res.usage.total_tokens ?? finalUsage.total_tokens ?? 0,
          };
        }
        if (typeof res.duration_seconds === 'number') {
          durationSeconds = res.duration_seconds;
        }
        if (res.structured_output && typeof res.structured_output === 'object') {
          finalResponse = res.structured_output;
        } else if (typeof res.response === 'string' && res.response.trim()) {
          try {
            finalResponse = JSON.parse(res.response);
          } catch {
            const match = res.response.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
            if (match) {
              try { finalResponse = JSON.parse(match[1]); } catch {}
            }
          }
        }
      }
    };

    child.stdout.on('data', (chunk) => {
      stdoutHash.update(chunk);
      stdoutBuffer += chunk.toString('utf8');
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          processEvent(event);
        } catch {}
      }
    });

    child.stderr.on('data', (chunk) => {
      stderrHash.update(chunk);
    });

    child.on('error', (error) => finish({
      exitCode: null,
      signal: null,
      error: error.message,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      stdoutSha256: stdoutHash.digest('hex'),
      stderrSha256: stderrHash.digest('hex'),
      eventCounts,
      usage: finalUsage,
      toolCalls,
      toolFailures,
      toolTrace: toolTrace.summary({ exitCode: 1 }),
      result: null,
    }));

    child.on('close', (exitCode, signal) => {
      if (settled) return;
      if (stdoutBuffer.trim()) {
        try {
          const event = JSON.parse(stdoutBuffer);
          processEvent(event);
        } catch {}
      }
      const measuredMs = durationSeconds ? Math.round(durationSeconds * 1000) : (Date.now() - startedAt.getTime());
      finish({
        exitCode,
        signal,
        error: null,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: measuredMs,
        stdoutSha256: stdoutHash.digest('hex'),
        stderrSha256: stderrHash.digest('hex'),
        eventCounts,
        usage: finalUsage,
        toolCalls,
        toolFailures,
        toolTrace: toolTrace.summary({ exitCode }),
        result: finalResponse,
      });
    });
  });
}

export function aggregateGeminiAbRuns(runs, variant, scenarioId = null) {
  const aggregated = baseAggregate(runs, variant, scenarioId);
  return {
    ...aggregated,
    uncachedInputTokens: null,
    medians: { ...aggregated.medians, uncachedInputTokens: null },
  };
}

export function evaluateGeminiPerformanceGate(baselineReference, candidateMetrics) {
  return evaluateRuntimeRoutingPerformance(baselineReference, candidateMetrics, {
    excludedChecks: {
      aggregate_uncached_input_tokens: "Gemini stream-json token accounting does not reliably isolate uncached input tokens from total input tokens",
    },
  });
}

export function computeEvaluationSummary({
  evaluationId,
  model,
  repetitions,
  selectedScenarios,
  sourceManifestData,
  contractSha,
  schemaSha,
  runs,
  runEvidence,
}) {
  const baselineAggregate = aggregateGeminiAbRuns(runs, 'baseline');
  const candidateAggregate = aggregateGeminiAbRuns(runs, 'candidate');

  const comparisons = selectedScenarios.map((s) => ({
    scenarioId: s.id,
    baseline: aggregateGeminiAbRuns(runs, 'baseline', s.id),
    candidate: aggregateGeminiAbRuns(runs, 'candidate', s.id),
    qualityNoWorse: aggregateGeminiAbRuns(runs, 'candidate', s.id).failed === 0,
    candidateAllPass: aggregateGeminiAbRuns(runs, 'candidate', s.id).failed === 0,
  }));

  const inputDelta = candidateAggregate.inputTokens - baselineAggregate.inputTokens;
  const inputDeltaRate = baselineAggregate.inputTokens ? Number((inputDelta / baselineAggregate.inputTokens).toFixed(4)) : 0;
  const outputDelta = candidateAggregate.outputTokens - baselineAggregate.outputTokens;
  const outputDeltaRate = baselineAggregate.outputTokens ? Number((outputDelta / baselineAggregate.outputTokens).toFixed(4)) : 0;
  const durationDelta = candidateAggregate.durationMs - baselineAggregate.durationMs;
  const durationDeltaRate = baselineAggregate.durationMs ? Number((durationDelta / baselineAggregate.durationMs).toFixed(4)) : 0;
  const toolCallDelta = candidateAggregate.toolCalls - baselineAggregate.toolCalls;
  const toolCallDeltaRate = baselineAggregate.toolCalls ? Number((toolCallDelta / baselineAggregate.toolCalls).toFixed(4)) : 0;

  const candidateMetrics = {
    metrics: candidateAggregate,
    scenarioMetrics: new Map(comparisons.map((c) => [c.scenarioId, c.candidate])),
  };
  const baselineReference = {
    metrics: baselineAggregate,
    scenarios: comparisons.map((c) => ({ scenarioId: c.scenarioId, metrics: c.baseline })),
  };
  const performanceGate = evaluateGeminiPerformanceGate(baselineReference, candidateMetrics);

  const expectedRuns = repetitions * selectedScenarios.length;
  const runsComplete = (
    baselineAggregate.runs === expectedRuns &&
    candidateAggregate.runs === expectedRuns
  );
  const allScenariosCovered = selectedScenarios.every((s) => (
    runs.some((r) => r.variant === 'baseline' && r.scenarioId === s.id) &&
    runs.some((r) => r.variant === 'candidate' && r.scenarioId === s.id)
  ));
  const coverageComplete = runsComplete && allScenariosCovered;

  const qualityNoWorse = comparisons.every((c) => c.qualityNoWorse);
  const candidateAllPass = candidateAggregate.failed === 0;
  const regression = candidateAggregate.failed > 0;
  const behaviorPass = candidateAllPass && qualityNoWorse && !regression;
  const performanceGatePass = performanceGate.verdict === 'pass';

  let providerVerdict;
  if (behaviorPass && performanceGatePass) {
    providerVerdict = 'provider_supported_gemini';
  } else if (behaviorPass && !performanceGatePass) {
    providerVerdict = 'provider_limited';
  } else {
    providerVerdict = 'fail';
  }

  return {
    schema_version: 'p2a.context_engineering_codex_ab_summary.v1',
    evaluationId,
    generatedAt: new Date().toISOString(),
    scope: {
      provider: 'gemini',
      model,
      reasoning: 'medium',
      repetitions,
      scenarios: selectedScenarios.map((s) => s.id),
      changeUnit: 'final runtime context packet feature toggle on gemini',
      limitations: [
        'This run does not exercise the complete production Gate/run lifecycle.',
        'Claude provider coverage remains absent due to tool/environment limits.',
        'Gemini token accounting does not reliably isolate uncached input tokens (cache_read_tokens may overlap with total input tokens), so uncached input token threshold check is excluded from Gemini performance gate.',
        'The A/B isolates the runtime packet feature toggle on the same behavioral cases and source tree on Gemini.',
      ],
    },
    sources: {
      baseline: {
        snapshotRef: 'current-source-legacy-routing-control',
        commitSha: null,
        dirty: true,
        files: sourceManifestData.files,
        sha256: sourceManifestData.sha256,
      },
      candidate: {
        snapshotRef: 'current-source-packet-treatment',
        commitSha: null,
        dirty: true,
        files: sourceManifestData.files,
        sha256: sourceManifestData.sha256,
      },
    },
    contractSha256: contractSha,
    outputSchemaSha256: schemaSha,
    baseline: baselineAggregate,
    candidate: candidateAggregate,
    comparisons,
    coverageComplete,
    regression,
    candidateAllPass,
    performanceGate,
    providerVerdict,
    inputTokenDelta: inputDelta,
    inputTokenDeltaRate: inputDeltaRate,
    uncachedInputTokenDelta: null,
    uncachedInputTokenDeltaRate: null,
    outputTokenDelta: outputDelta,
    outputTokenDeltaRate: outputDeltaRate,
    durationDeltaMs: durationDelta,
    durationDeltaRate: durationDeltaRate,
    toolCallDelta,
    toolCallDeltaRate: toolCallDeltaRate,
    runtimeContextTreatment: {
      baseline: 'legacy_model_routed',
      candidate: 'packet_supplied',
    },
    runEvidence,
  };
}

async function runPreflight(options, baselineSnapshot, candidateSnapshot) {
  console.log('=== Preflight Validation ===');
  const { contract } = loadEvaluationContract(options.contract);
  const baselineScenario = contract.scenarios.find((s) => s.id === 'gate-b-spec');
  const candidateScenario = contract.scenarios.find((s) => s.id === 'direct-execution');

  console.log('1. Running Preflight Baseline (gate-b-spec)...');
  const baselinePrompt = promptFor(baselineScenario, baselineSnapshot.path, null);
  const baselineAllowlist = traceSourceAllowlist(baselineSnapshot.path, baselineScenario);
  const baselineExec = await runAgy({
    cwd: baselineSnapshot.path,
    model: options.model,
    schemaPath: options.schema,
    prompt: baselinePrompt,
    sourceAllowlist: baselineAllowlist,
  });

  const baselineGrade = gradeResult(baselineScenario, baselineExec.result);
  console.log(`   Baseline Exit: ${baselineExec.exitCode}, Result Parsed: ${baselineExec.result != null}, Grade: ${baselineGrade.verdict}, Duration: ${baselineExec.durationMs}ms`);
  console.log(`   Baseline Usage: input=${baselineExec.usage?.input_tokens}, cached=${baselineExec.usage?.cached_input_tokens}, output=${baselineExec.usage?.output_tokens}`);
  console.log(`   Baseline Trace: status=${baselineExec.toolTrace?.status}, toolOps=${baselineExec.toolTrace?.metrics?.toolOperations}, unattributed=${baselineExec.toolTrace?.metrics?.unattributedReadOperations}`);

  console.log('2. Running Preflight Candidate (direct-execution with packet)...');
  const candidateFixture = buildRuntimeContextFixture(candidateSnapshot.path, candidateScenario);
  const candidatePrompt = promptFor(candidateScenario, candidateSnapshot.path, candidateFixture);
  const candidateAllowlist = traceSourceAllowlist(candidateSnapshot.path, candidateScenario);
  const candidateExec = await runAgy({
    cwd: candidateSnapshot.path,
    model: options.model,
    schemaPath: options.schema,
    prompt: candidatePrompt,
    sourceAllowlist: candidateAllowlist,
  });

  const candidateGrade = gradeResult(candidateScenario, candidateExec.result);
  console.log(`   Candidate Exit: ${candidateExec.exitCode}, Result Parsed: ${candidateExec.result != null}, Grade: ${candidateGrade.verdict}, Duration: ${candidateExec.durationMs}ms`);
  console.log(`   Candidate Usage: input=${candidateExec.usage?.input_tokens}, cached=${candidateExec.usage?.cached_input_tokens}, output=${candidateExec.usage?.output_tokens}`);
  console.log(`   Candidate Trace: status=${candidateExec.toolTrace?.status}, toolOps=${candidateExec.toolTrace?.metrics?.toolOperations}, unattributed=${candidateExec.toolTrace?.metrics?.unattributedReadOperations}`);

  const candidatePacketAttributionComplete = candidateExec.toolTrace?.metrics?.packetManagedAttributionComplete === true;
  const candidatePacketUnattributedZero = candidateExec.toolTrace?.metrics?.packetManagedUnattributedReadOperations === 0;
  const candidatePacketRepeatedZero = candidateExec.toolTrace?.metrics?.packetManagedRepeatedSourceReads === 0;
  const candidateUnknownZero = candidateExec.toolTrace?.metrics?.unknownOperations === 0;

  const checks = [
    { name: 'Baseline Result Parsed', pass: baselineExec.result != null },
    { name: 'Baseline Grade Pass', pass: baselineGrade.verdict === 'pass' },
    { name: 'Baseline Duration Measured', pass: Number.isFinite(baselineExec.durationMs) && baselineExec.durationMs > 0 },
    { name: 'Baseline Usage Collected', pass: Number.isFinite(baselineExec.usage?.input_tokens) && baselineExec.usage.input_tokens > 0 },
    { name: 'Baseline Trace Captured', pass: ['available', 'partial'].includes(baselineExec.toolTrace?.status) },
    { name: 'Candidate Result Parsed', pass: candidateExec.result != null },
    { name: 'Candidate Grade Pass', pass: candidateGrade.verdict === 'pass' },
    { name: 'Candidate Duration Measured', pass: Number.isFinite(candidateExec.durationMs) && candidateExec.durationMs > 0 },
    { name: 'Candidate Usage Collected', pass: Number.isFinite(candidateExec.usage?.input_tokens) && candidateExec.usage.input_tokens > 0 },
    { name: 'Candidate Packet Attribution Complete', pass: candidatePacketAttributionComplete },
    { name: 'Candidate Packet Unattributed Reads Zero', pass: candidatePacketUnattributedZero },
    { name: 'Candidate Packet Repeated Reads Zero', pass: candidatePacketRepeatedZero },
    { name: 'Candidate Unknown Operations Zero', pass: candidateUnknownZero },
  ];

  console.log('\n--- Preflight Summary ---');
  let allPass = true;
  for (const c of checks) {
    console.log(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.name}`);
    if (!c.pass) allPass = false;
  }

  const preflightEvidence = {
    schema_version: 'p2a.context_engineering_preflight_evidence.v1',
    timestamp: new Date().toISOString(),
    baseline: {
      scenarioId: baselineScenario.id,
      exitCode: baselineExec.exitCode,
      durationMs: baselineExec.durationMs,
      usage: baselineExec.usage,
      grade: baselineGrade,
      toolTrace: baselineExec.toolTrace,
    },
    candidate: {
      scenarioId: candidateScenario.id,
      exitCode: candidateExec.exitCode,
      durationMs: candidateExec.durationMs,
      usage: candidateExec.usage,
      grade: candidateGrade,
      toolTrace: candidateExec.toolTrace,
    },
    checks,
    verdict: allPass ? 'pass' : 'fail',
  };

  mkdirSync(options.output, { recursive: true });
  const preflightPath = path.join(options.output, 'preflight-summary.json');
  writeFileSync(preflightPath, JSON.stringify(preflightEvidence, null, 2));
  console.log(`Preflight evidence written to: ${preflightPath}`);

  if (!allPass) {
    fail('Preflight validation failed (partial candidate trace or behavioral error)! Aborting execution.');
  }
  console.log('Preflight validation PASSED!\n');
}

export async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`[P2A Gemini A/B Runner] Model: ${args.model}, Repetitions: ${args.repetitions}`);
  console.log(`Contract: ${args.contract}`);
  console.log(`Output: ${args.output}`);

  validateOutputDir(args.output);

  const { contract, sha256: contractSha, evaluationId } = loadEvaluationContract(args.contract);
  const schemaContent = readFileSync(args.schema, 'utf8');
  const schemaSha = sha256(schemaContent);

  const selectedScenarios = contract.scenarios.filter((s) => args.scenarios.includes(s.id));
  if (selectedScenarios.length === 0) fail(`No scenarios matched: ${args.scenarios.join(', ')}`);

  const manifestBeforeBaseline = sourceManifest(args.baseline);
  const manifestBeforeCandidate = sourceManifest(args.candidate);

  if (args.dryRun) {
    console.log('\n=== Dry Run Execution Plan ===');
    console.log(`Scenarios (${selectedScenarios.length}): ${selectedScenarios.map((s) => s.id).join(', ')}`);
    console.log(`Repetitions: ${args.repetitions} (Total runs: ${args.repetitions * selectedScenarios.length * 2})`);
    console.log('Execution order: Interleaved and counterbalanced by repetition and scenario');
    console.log(`Baseline source files: ${manifestBeforeBaseline.files} (SHA256: ${manifestBeforeBaseline.sha256})`);
    console.log(`Candidate source files: ${manifestBeforeCandidate.files} (SHA256: ${manifestBeforeCandidate.sha256})`);
    console.log('Isolation: Temporary immutable snapshots will be used as agy working directories');
    console.log('Dry run complete. No model calls or preflight executed.');
    return;
  }

  let baselineSnapshot = null;
  let candidateSnapshot = null;

  try {
    console.log('\nCreating isolated source snapshots...');
    baselineSnapshot = createIsolatedSourceSnapshot(args.baseline, 'baseline');
    candidateSnapshot = createIsolatedSourceSnapshot(args.candidate, 'candidate');
    console.log(`  Baseline snapshot: ${baselineSnapshot.path} (${baselineSnapshot.manifest.files} files)`);
    console.log(`  Candidate snapshot: ${candidateSnapshot.path} (${candidateSnapshot.manifest.files} files)`);

    await runPreflight(args, baselineSnapshot, candidateSnapshot);
    if (args.preflightOnly) {
      console.log('Preflight only requested. Exiting.');
      return;
    }

    const runs = [];
    const runEvidence = [];

    for (let rep = 1; rep <= args.repetitions; rep += 1) {
      const runIdStr = `run-${String(rep).padStart(2, '0')}`;
      console.log(`\n================ Repetition ${rep}/${args.repetitions} ================`);

      for (let scenarioIdx = 0; scenarioIdx < selectedScenarios.length; scenarioIdx += 1) {
        const scenario = selectedScenarios[scenarioIdx];
        const variants = (rep + scenarioIdx) % 2 === 0
          ? ['baseline', 'candidate']
          : ['candidate', 'baseline'];

        for (const variant of variants) {
          const isCandidate = variant === 'candidate';
          const snapshot = isCandidate ? candidateSnapshot : baselineSnapshot;
          const runDir = path.join(args.output, variant, scenario.id, 'agy', args.model, runIdStr);
          mkdirSync(runDir, { recursive: true });

          console.log(`  [Rep ${rep}/${args.repetitions} | ${variant.toUpperCase()} ${scenario.id}] Executing in snapshot...`);
          const runtimeContext = isCandidate ? buildRuntimeContextFixture(snapshot.path, scenario) : null;
          const prompt = promptFor(scenario, snapshot.path, runtimeContext);
          const promptSha = sha256(prompt);
          const allowlist = traceSourceAllowlist(snapshot.path, scenario);

          const execution = await runAgy({
            cwd: snapshot.path,
            model: args.model,
            schemaPath: args.schema,
            prompt,
            sourceAllowlist: allowlist,
          });

          const grade = gradeResult(scenario, execution.result);
          console.log(`     Verdict: ${grade.verdict} | Duration: ${execution.durationMs}ms | Input: ${execution.usage?.input_tokens} | Cached: ${execution.usage?.cached_input_tokens} | Output: ${execution.usage?.output_tokens} | Tools: ${execution.toolCalls}`);

          const resultPath = path.join(runDir, 'result.json');
          const gradePath = path.join(runDir, 'grade.json');
          const metadataPath = path.join(runDir, 'metadata.json');

          const resultJsonStr = JSON.stringify(execution.result ?? {}, null, 2);
          const gradeJsonStr = JSON.stringify(grade, null, 2);

          writeFileSync(resultPath, resultJsonStr);
          writeFileSync(gradePath, gradeJsonStr);

          const metadata = {
            schema_version: 'p2a.context_engineering_codex_ab_run.v1',
            evaluationId: args.evaluationId,
            variant,
            scenarioId: scenario.id,
            repetition: rep,
            provider: 'gemini',
            model: args.model,
            reasoning: 'medium',
            modelProfile: `agy/${args.model}/medium`,
            source: {
              snapshotRef: isCandidate ? 'current-source-packet-treatment' : 'current-source-legacy-routing-control',
              commitSha: null,
              baseCommitSha: null,
              dirty: true,
              files: snapshot.manifest.files,
              sha256: snapshot.manifest.sha256,
            },
            contractSha256: contractSha,
            gradingContractSha256: contractSha,
            outputSchemaSha256: schemaSha,
            scenarioCaseSha256: sha256(stableJson(scenario.case)),
            promptSha256: promptSha,
            behavioralContext: runtimeContext?.metadata ?? null,
            command: {
              executable: 'agy',
              mode: 'plan',
              sandbox: 'sandboxed',
              outputFormat: 'stream-json',
              cliVersion: '1.1.13',
            },
            execution: {
              exitCode: execution.exitCode,
              signal: execution.signal,
              error: execution.error,
              startedAt: execution.startedAt,
              finishedAt: execution.finishedAt,
              durationMs: execution.durationMs,
              stdoutSha256: execution.stdoutSha256,
              stderrSha256: execution.stderrSha256,
              eventCounts: execution.eventCounts,
              usage: execution.usage,
              toolCalls: execution.toolCalls,
              toolFailures: execution.toolFailures,
              toolTrace: execution.toolTrace,
            },
            resultSha256: sha256(resultJsonStr),
            gradeSha256: sha256(gradeJsonStr),
            verdict: grade.verdict,
          };

          const metadataJsonStr = JSON.stringify(metadata, null, 2);
          writeFileSync(metadataPath, metadataJsonStr);

          const relMetadata = path.relative(PROJECT_ROOT, metadataPath);
          const relGrade = path.relative(PROJECT_ROOT, gradePath);
          const relResult = path.relative(PROJECT_ROOT, resultPath);

          runEvidence.push({
            variant,
            scenarioId: scenario.id,
            repetition: rep,
            metadata: relMetadata,
            metadataSha256: sha256(metadataJsonStr),
            grade: relGrade,
            gradeSha256: sha256(gradeJsonStr),
            initialGrade: null,
            initialGradeSha256: null,
            result: relResult,
            resultSha256: sha256(resultJsonStr),
          });

          runs.push({
            variant,
            scenarioId: scenario.id,
            repetition: rep,
            metadata,
            grade,
            result: execution.result,
          });
        }
      }
    }

    const manifestAfterBaseline = sourceManifest(baselineSnapshot.path);
    const manifestAfterCandidate = sourceManifest(candidateSnapshot.path);

    if (baselineSnapshot.manifest.sha256 !== manifestAfterBaseline.sha256 || baselineSnapshot.manifest.files !== manifestAfterBaseline.files) {
      fail(`Baseline snapshot mutated during execution! Before: ${baselineSnapshot.manifest.sha256}, After: ${manifestAfterBaseline.sha256}`);
    }
    if (candidateSnapshot.manifest.sha256 !== manifestAfterCandidate.sha256 || candidateSnapshot.manifest.files !== manifestAfterCandidate.files) {
      fail(`Candidate snapshot mutated during execution! Before: ${candidateSnapshot.manifest.sha256}, After: ${manifestAfterCandidate.sha256}`);
    }

    console.log('\n=== Aggregating Results ===');
    const summary = computeEvaluationSummary({
      evaluationId: args.evaluationId,
      model: args.model,
      repetitions: args.repetitions,
      selectedScenarios,
      sourceManifestData: baselineSnapshot.manifest,
      contractSha,
      schemaSha,
      runs,
      runEvidence,
    });

    const summaryPath = path.join(args.output, 'gemini-ab-summary.json');
    writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
    console.log(`Summary written to: ${summaryPath}`);

    console.log('\n================ FINAL RESULTS ================');
    console.log(`Baseline Pass: ${summary.baseline.passed}/${summary.baseline.runs}, Candidate Pass: ${summary.candidate.passed}/${summary.candidate.runs}`);
    console.log(`Input Tokens: Baseline=${summary.baseline.inputTokens} -> Candidate=${summary.candidate.inputTokens} (${(summary.inputTokenDeltaRate * 100).toFixed(2)}%)`);
    console.log(`Duration: Baseline=${summary.baseline.durationMs}ms -> Candidate=${summary.candidate.durationMs}ms (${(summary.durationDeltaRate * 100).toFixed(2)}%)`);
    console.log(`Tool Operations: Baseline=${summary.baseline.toolOperations} -> Candidate=${summary.candidate.toolOperations} (${(summary.toolCallDeltaRate * 100).toFixed(2)}%)`);
    console.log(`Performance Gate Verdict: ${summary.performanceGate.verdict}`);
    console.log(`Provider Verdict: ${summary.providerVerdict}`);
    console.log('===============================================');
  } finally {
    let cleanupError = null;
    if (candidateSnapshot) {
      try {
        candidateSnapshot.cleanup();
      } catch (err) {
        cleanupError = err;
      }
    }
    if (baselineSnapshot) {
      try {
        baselineSnapshot.cleanup();
      } catch (err) {
        cleanupError = cleanupError ?? err;
      }
    }
    if (cleanupError) throw cleanupError;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('Fatal error:', err.message || err);
    process.exit(1);
  });
}
