#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { aggregateAbRuns as aggregate } from '../../../../../scripts/p2a_ab_metrics.mjs';
import {
  evaluateRuntimeRoutingPerformance,
  validatePerformanceReference,
} from '../../../../../scripts/p2a_runtime_performance_gate.mjs';
import { SanitizedToolTrace } from '../../../../../scripts/p2a_tool_trace.mjs';
import {
  gradeRuntimeRoutingResult as gradeResult,
  loadRuntimeEvaluationContract as loadEvaluationContract,
  runtimeEvaluationSourceManifest as sourceManifest,
  stableJson,
} from '../../../../../scripts/p2a_runtime_eval_core.mjs';
import { buildRuntimeContextFixture } from '../../../../../scripts/p2a_runtime_context_fixture.mjs';

const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '../../../../..');
const DEFAULT_CONTRACT = path.join(SCRIPT_DIR, 'contract.json');
const DEFAULT_SCHEMA = path.join(SCRIPT_DIR, 'result.schema.json');
const DEFAULT_OUTPUT = path.join(PROJECT_ROOT, 'plans/evidence/context-engineering/CE-009');

function fail(message) {
  console.error(message);
  process.exit(1);
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

function parseArgs(argv) {
  const args = {
    baseline: null,
    candidate: null,
    contract: DEFAULT_CONTRACT,
    schema: DEFAULT_SCHEMA,
    output: DEFAULT_OUTPUT,
    model: 'gpt-5.6-luna',
    reasoning: 'medium',
    repetitions: 3,
    scenarios: [],
    baselineCommit: null,
    candidateBaseCommit: null,
    candidatePatchSha: null,
    candidateUntrackedSha: null,
    codexCliVersion: null,
    evaluationId: null,
    instrumentedCurrent: false,
    candidateContextPackets: false,
    performanceReference: null,
    regrade: false,
    regradeFrom: null,
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--baseline') args.baseline = requiredValue(argv, ++index, arg);
    else if (arg === '--candidate') args.candidate = requiredValue(argv, ++index, arg);
    else if (arg === '--contract') args.contract = requiredValue(argv, ++index, arg);
    else if (arg === '--schema') args.schema = requiredValue(argv, ++index, arg);
    else if (arg === '--output') args.output = requiredValue(argv, ++index, arg);
    else if (arg === '--model') args.model = requiredValue(argv, ++index, arg);
    else if (arg === '--reasoning') args.reasoning = requiredValue(argv, ++index, arg);
    else if (arg === '--repetitions') args.repetitions = parsePositiveInteger(requiredValue(argv, ++index, arg), arg);
    else if (arg === '--scenario') args.scenarios.push(requiredValue(argv, ++index, arg));
    else if (arg === '--baseline-commit') args.baselineCommit = requiredValue(argv, ++index, arg);
    else if (arg === '--candidate-base-commit') args.candidateBaseCommit = requiredValue(argv, ++index, arg);
    else if (arg === '--candidate-patch-sha') args.candidatePatchSha = requiredValue(argv, ++index, arg);
    else if (arg === '--candidate-untracked-sha') args.candidateUntrackedSha = requiredValue(argv, ++index, arg);
    else if (arg === '--codex-cli-version') args.codexCliVersion = requiredValue(argv, ++index, arg);
    else if (arg === '--evaluation-id') args.evaluationId = requiredValue(argv, ++index, arg);
    else if (arg === '--instrumented-current') args.instrumentedCurrent = true;
    else if (arg === '--candidate-context-packets') args.candidateContextPackets = true;
    else if (arg === '--performance-reference') args.performanceReference = requiredValue(argv, ++index, arg);
    else if (arg === '--regrade') args.regrade = true;
    else if (arg === '--regrade-from') args.regradeFrom = requiredValue(argv, ++index, arg);
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--help' || arg === '-h') {
      console.log([
        'Usage:',
        '  node run-codex-ab.mjs --baseline <dir> --candidate <dir> [options]',
        '',
        'Options:',
        '  --model <slug>          Default: gpt-5.6-luna',
        '  --reasoning <effort>    Default: medium',
        '  --repetitions <n>       Default: 3',
        '  --scenario <id>         Select a scenario; repeat to select several',
        '  --baseline-commit <sha>  Source commit for the baseline snapshot',
        '  --candidate-base-commit <sha>',
        '  --candidate-patch-sha <sha256>',
        '  --candidate-untracked-sha <sha256>',
        '  --codex-cli-version <version>',
        '  --evaluation-id <id>    Stable evidence id',
        '  --instrumented-current  Measure candidate only with sanitized trace; requires at least 5 repetitions and a distinct --output',
        '  --candidate-context-packets  A/B only: supply resolver-selected packets to candidate behavioral prompts',
        '  --performance-reference <summary>  Frozen trace baseline required by the final packet A/B gate',
        '  --regrade               Recompute grades from preserved final results without model calls',
        '  --regrade-from <dir>    Copy preserved results into a distinct regraded evidence root',
        '  --output <dir>          CE-009 evidence root',
        '  --dry-run               Validate and print the matrix without model calls',
      ].join('\n'));
      process.exit(0);
    } else fail(`unknown option: ${arg}`);
  }
  if (!args.candidate || (!args.instrumentedCurrent && !args.baseline)) {
    fail(args.instrumentedCurrent ? '--candidate is required' : '--baseline and --candidate are required');
  }
  if (args.instrumentedCurrent && args.repetitions < 5) fail('--instrumented-current requires at least 5 repetitions');
  if (args.instrumentedCurrent && path.resolve(args.output) === path.resolve(DEFAULT_OUTPUT)) {
    fail('--instrumented-current requires a distinct --output so historical CE-009 evidence is not overwritten');
  }
  if (args.instrumentedCurrent && args.candidateContextPackets) {
    fail('--candidate-context-packets requires a baseline/candidate A/B run');
  }
  if (args.candidateContextPackets && !args.performanceReference) {
    fail('--candidate-context-packets requires --performance-reference');
  }
  if (args.regradeFrom && !args.regrade) fail('--regrade-from requires --regrade');
  return args;
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

function cleanEnvironment() {
  const allowed = [
    'HOME',
    'LANG',
    'LC_ALL',
    'LOGNAME',
    'PATH',
    'SHELL',
    'TERM',
    'TMPDIR',
    'USER',
  ];
  return Object.fromEntries(allowed
    .filter((key) => typeof process.env[key] === 'string')
    .map((key) => [key, process.env[key]]));
}

function promptFor(scenario, runtimeContext = null) {
  const lines = [
    'You are one isolated evaluation subject for Plan2Agent context engineering.',
    'Work read-only. Do not modify files, access paths outside this workspace, use network access, or ask the user questions.',
    'Read every primary skill listed below in full. Follow its own routing instructions and load additional references only when the case meets their stated condition.',
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
    `Primary skills: ${scenario.primary_skills.join(', ')}`,
    `Case JSON: ${JSON.stringify(scenario.case)}`,
  );
  if (runtimeContext) lines.push('', runtimeContext.modelPacket.trimEnd());
  return lines.join('\n');
}

function traceSourceAllowlist(sourceRoot, scenario, runtimeContext = null) {
  const entries = [];
  const packetRouteIds = new Set(runtimeContext?.metadata?.routeIds ?? []);
  const add = (id, relativePaths, packetManaged = false) => {
    const paths = relativePaths.flatMap((relativePath) => [
      relativePath,
      path.resolve(sourceRoot, relativePath),
    ]);
    entries.push({ id, paths, packetManaged });
  };
  for (const primarySkill of scenario.primary_skills ?? []) {
    const normalized = primarySkill.replaceAll(path.sep, '/');
    const parts = normalized.split('/');
    const skillIndex = parts.lastIndexOf('skills');
    const skillId = skillIndex >= 0 ? parts[skillIndex + 1] : path.basename(path.dirname(normalized));
    add(`skill:${skillId}`, [normalized], false);
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
          .filter((item) => item?.provider === 'codex' && typeof item.path === 'string')
          .map((item) => path.posix.join('.agents', 'skills', skill.id, item.path)),
      ], packetRouteIds.has(sourceId));
    }
  }
  return entries;
}

function increment(target, key) {
  target[key] = (target[key] ?? 0) + 1;
}

function collectUsage(value, usage) {
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'].includes(key)
      && Number.isFinite(nested)) {
      usage[key] = Math.max(usage[key] ?? 0, nested);
    } else if (nested && typeof nested === 'object') collectUsage(nested, usage);
  }
}

function runCodex({ cwd, model, reasoning, schema, outputFile, prompt, sourceAllowlist }) {
  return new Promise((resolve) => {
    const startedAt = new Date();
    const stdoutHash = createHash('sha256');
    const stderrHash = createHash('sha256');
    const eventCounts = {};
    const usage = {};
    let stdoutBuffer = '';
    let toolCalls = 0;
    let toolFailures = 0;
    const toolTrace = new SanitizedToolTrace(sourceAllowlist, { workspaceRoot: cwd });
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      resolve(payload);
    };
    const child = spawn('codex', [
      'exec',
      '--ephemeral',
      '--ignore-user-config',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '--model',
      model,
      '--config',
      `model_reasoning_effort=${JSON.stringify(reasoning)}`,
      '--output-schema',
      schema,
      '--output-last-message',
      outputFile,
      '--json',
      prompt,
    ], {
      cwd,
      env: cleanEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const processEvent = (event) => {
      increment(eventCounts, event.type ?? 'unknown');
      collectUsage(event, usage);
      if (event.type === 'item.completed' && event.item?.type === 'command_execution') {
        toolCalls += 1;
        if (event.item.exit_code !== 0) toolFailures += 1;
        toolTrace.observe(event);
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
        } catch {
          increment(eventCounts, 'invalid_jsonl');
        }
      }
    });
    child.stderr.on('data', (chunk) => stderrHash.update(chunk));
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
      usage,
      toolCalls,
      toolFailures,
      toolTrace: toolTrace.summary(),
    }));
    child.on('close', (exitCode, signal) => {
      if (settled) return;
      if (stdoutBuffer.trim()) {
        try {
          const event = JSON.parse(stdoutBuffer);
          processEvent(event);
        } catch {
          increment(eventCounts, 'invalid_jsonl');
        }
      }
      finish({
        exitCode,
        signal,
        error: null,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt.getTime(),
        stdoutSha256: stdoutHash.digest('hex'),
        stderrSha256: stderrHash.digest('hex'),
        eventCounts,
        usage,
        toolCalls,
        toolFailures,
        toolTrace: toolTrace.summary(),
      });
    });
  });
}

function writeJson(filePath, payload) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function profileLabel(model, reasoning) {
  return `${model}-${reasoning}`.replace(/[^a-zA-Z0-9._-]/g, '-');
}

function resultPaths(outputRoot, variant, scenarioId, profile, repetition) {
  const runDir = path.join(outputRoot, variant, scenarioId, 'codex', profile, `run-${String(repetition).padStart(2, '0')}`);
  return {
    runDir,
    result: path.join(runDir, 'result.json'),
    grade: path.join(runDir, 'grade.json'),
    initialGrade: path.join(runDir, 'grade.initial.json'),
    metadata: path.join(runDir, 'metadata.json'),
  };
}

async function executeOne({ args, scenario, variant, sourceRoot, source, contractHash, schemaHash, repetition }) {
  const profile = profileLabel(args.model, args.reasoning);
  const files = resultPaths(args.output, variant, scenario.id, profile, repetition);
  if (args.regradeFrom) {
    if (statSafe(files.metadata) || statSafe(files.result) || statSafe(files.grade)) {
      fail(`regrade output already exists: ${path.relative(PROJECT_ROOT, files.runDir)}`);
    }
    const preserved = resultPaths(args.regradeFrom, variant, scenario.id, profile, repetition);
    if (!statSafe(preserved.metadata) || !statSafe(preserved.grade) || !statSafe(preserved.result)) {
      fail(`regrade source evidence is incomplete: ${path.relative(PROJECT_ROOT, preserved.runDir)}`);
    }
    const originalMetadata = readJson(preserved.metadata, 'regrade source metadata');
    const originalGrade = readJson(preserved.grade, 'regrade source grade');
    const parsed = parseJsonFile(preserved.result);
    const result = parsed.value;
    const grade = result ? gradeResult(scenario, result) : {
      schema_version: 'p2a.context_engineering_codex_ab_grade.v1',
      scenarioId: scenario.id,
      verdict: 'fail',
      score: 0,
      checks: [{ id: 'structured_result', pass: false, expected: 'valid JSON result', actual: parsed.error ?? 'missing' }],
    };
    mkdirSync(files.runDir, { recursive: true });
    copyFileSync(preserved.result, files.result);
    writeJson(files.initialGrade, originalGrade);
    writeJson(files.grade, grade);
    const metadata = {
      ...originalMetadata,
      evaluationId: args.evaluationId,
      gradingContractSha256: contractHash,
      initialGradeSha256: sha256(readFileSync(preserved.grade)),
      regradedFrom: path.relative(PROJECT_ROOT, preserved.runDir),
      regradedAt: new Date().toISOString(),
      resultSha256: sha256(readFileSync(files.result)),
      gradeSha256: sha256(readFileSync(files.grade)),
      verdict: grade.verdict,
    };
    writeJson(files.metadata, metadata);
    console.log(`regrade-copy ${variant}/${scenario.id}/run-${repetition}: verdict=${grade.verdict}`);
    return { variant, scenarioId: scenario.id, repetition, files, metadata, grade };
  }
  if (statSafe(files.metadata)) {
    const metadata = readJson(files.metadata, 'existing run metadata');
    let grade = statSafe(files.grade) ? readJson(files.grade, 'existing grade') : null;
    if (args.regrade) {
      const parsed = parseJsonFile(files.result);
      grade = parsed.value ? gradeResult(scenario, parsed.value) : {
        schema_version: 'p2a.context_engineering_codex_ab_grade.v1',
        scenarioId: scenario.id,
        verdict: 'fail',
        score: 0,
        checks: [{ id: 'structured_result', pass: false, expected: 'valid JSON result', actual: parsed.error ?? 'missing' }],
      };
      const previousGradeSha256 = statSafe(files.grade) ? sha256(readFileSync(files.grade)) : null;
      if (statSafe(files.grade) && !statSafe(files.initialGrade)) copyFileSync(files.grade, files.initialGrade);
      writeJson(files.grade, grade);
      metadata.initialGradeSha256 ??= previousGradeSha256;
      metadata.gradeSha256 = sha256(readFileSync(files.grade));
      metadata.gradingContractSha256 = contractHash;
      metadata.regradedAt = new Date().toISOString();
      metadata.verdict = grade.verdict;
      writeJson(files.metadata, metadata);
      console.log(`regrade ${variant}/${scenario.id}/run-${repetition}: verdict=${grade.verdict}`);
    } else {
      console.log(`skip ${variant}/${scenario.id}/run-${repetition}: existing evidence`);
    }
    return { variant, scenarioId: scenario.id, repetition, files, metadata, grade };
  }
  mkdirSync(files.runDir, { recursive: true });
  console.log(`start ${variant}/${scenario.id}/run-${repetition}`);
  const runtimeContext = args.candidateContextPackets && variant === 'candidate'
    ? buildRuntimeContextFixture(sourceRoot, scenario)
    : null;
  const prompt = promptFor(scenario, runtimeContext);
  const execution = await runCodex({
    cwd: sourceRoot,
    model: args.model,
    reasoning: args.reasoning,
    schema: args.schema,
    outputFile: files.result,
    prompt,
    sourceAllowlist: traceSourceAllowlist(sourceRoot, scenario, runtimeContext),
  });
  const parsed = parseJsonFile(files.result);
  const result = parsed.value;
  const parseError = parsed.error;
  const grade = result ? gradeResult(scenario, result) : {
    schema_version: 'p2a.context_engineering_codex_ab_grade.v1',
    scenarioId: scenario.id,
    verdict: 'fail',
    score: 0,
    checks: [{ id: 'structured_result', pass: false, expected: 'valid JSON result', actual: parseError ?? 'missing' }],
  };
  const metadata = {
    schema_version: 'p2a.context_engineering_codex_ab_run.v1',
    evaluationId: args.evaluationId,
    variant,
    scenarioId: scenario.id,
    repetition,
    provider: 'codex',
    model: args.model,
    reasoning: args.reasoning,
    modelProfile: `codex/${args.model}/${args.reasoning}`,
    source,
    contractSha256: contractHash,
    gradingContractSha256: contractHash,
    outputSchemaSha256: schemaHash,
    scenarioCaseSha256: sha256(stableJson(scenario.case)),
    promptSha256: sha256(prompt),
    behavioralContext: runtimeContext?.metadata ?? {
      schema_version: 'p2a.context_engineering_runtime_context_fixture.v1',
      status: 'legacy_model_routed',
    },
    command: {
      executable: 'codex',
      mode: 'exec',
      ephemeral: true,
      ignoreUserConfig: true,
      sandbox: 'read-only',
      networkInstruction: 'disabled',
      cliVersion: args.codexCliVersion,
    },
    execution,
    resultSha256: result ? sha256(readFileSync(files.result)) : null,
    gradeSha256: null,
    verdict: grade.verdict,
  };
  writeJson(files.grade, grade);
  metadata.gradeSha256 = sha256(readFileSync(files.grade));
  writeJson(files.metadata, metadata);
  console.log(`finish ${variant}/${scenario.id}/run-${repetition}: exit=${execution.exitCode} verdict=${grade.verdict} input=${execution.usage.input_tokens ?? 'n/a'}`);
  return { variant, scenarioId: scenario.id, repetition, files, metadata, grade };
}

function statSafe(filePath) {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function finiteDelta(candidate, baseline) {
  return Number.isFinite(candidate) && Number.isFinite(baseline)
    ? candidate - baseline
    : null;
}

function finiteDeltaRate(candidate, baseline) {
  return Number.isFinite(candidate) && Number.isFinite(baseline) && baseline !== 0
    ? Number(((candidate - baseline) / baseline).toFixed(4))
    : null;
}

function buildSummary(args, scenarios, runs, sources, contractHash, schemaHash) {
  const baseline = aggregate(runs, 'baseline');
  const candidate = aggregate(runs, 'candidate');
  const comparisons = scenarios.map((scenario) => {
    const a = aggregate(runs, 'baseline', scenario.id);
    const b = aggregate(runs, 'candidate', scenario.id);
    return {
      scenarioId: scenario.id,
      baseline: a,
      candidate: b,
      qualityNoWorse: b.passed >= a.passed,
      candidateAllPass: b.failed === 0 && b.runs === args.repetitions,
    };
  });
  const coverageComplete = baseline.runs === scenarios.length * args.repetitions
    && candidate.runs === scenarios.length * args.repetitions;
  const measurementComplete = baseline.measurementCoverage.complete
    && candidate.measurementCoverage.complete;
  const regression = comparisons.some((item) => !item.qualityNoWorse);
  const candidateAllPass = comparisons.every((item) => item.candidateAllPass);
  const scenarioMetrics = new Map(comparisons.map((item) => [item.scenarioId, item.candidate]));
  const performanceGate = args.performanceReferenceSummary
    ? evaluateRuntimeRoutingPerformance(args.performanceReferenceSummary, {
        metrics: candidate,
        scenarioMetrics,
      })
    : null;
  const performanceRegression = performanceGate?.verdict === 'fail';
  const providerVerdict = !coverageComplete || !measurementComplete
    ? 'inconclusive'
    : regression || !candidateAllPass || performanceRegression ? 'no_go' : 'provider_limited';
  return {
    schema_version: 'p2a.context_engineering_codex_ab_summary.v1',
    evaluationId: args.evaluationId,
    generatedAt: new Date().toISOString(),
    scope: {
      provider: 'codex',
      model: args.model,
      reasoning: args.reasoning,
      repetitions: args.repetitions,
      scenarios: scenarios.map((scenario) => scenario.id),
      changeUnit: args.candidateContextPackets
        ? 'final runtime context packet feature toggle'
        : 'combined CE-001 through CE-008 dirty candidate',
      limitations: [
        ...(args.candidateContextPackets
          ? []
          : ['This aggregate behavioral A/B does not isolate each CE change unit.']),
        'This run does not exercise the complete production Gate/run lifecycle.',
        'Claude and Gemini provider coverage is absent.',
        ...(args.candidateContextPackets
          ? ['The A/B isolates the runtime packet feature toggle on the same behavioral cases and source tree.']
          : []),
      ],
    },
    sources,
    contractSha256: contractHash,
    outputSchemaSha256: schemaHash,
    baseline,
    candidate,
    comparisons,
    coverageComplete,
    measurementComplete,
    regression,
    candidateAllPass,
    performanceGate,
    performanceReference: args.performanceReferenceSummary ? {
      path: path.relative(PROJECT_ROOT, args.performanceReference),
      sha256: sha256(readFileSync(args.performanceReference)),
    } : null,
    providerVerdict,
    inputTokenDelta: finiteDelta(candidate.inputTokens, baseline.inputTokens),
    inputTokenDeltaRate: finiteDeltaRate(candidate.inputTokens, baseline.inputTokens),
    uncachedInputTokenDelta: finiteDelta(candidate.uncachedInputTokens, baseline.uncachedInputTokens),
    uncachedInputTokenDeltaRate: finiteDeltaRate(
      candidate.uncachedInputTokens,
      baseline.uncachedInputTokens,
    ),
    outputTokenDelta: finiteDelta(candidate.outputTokens, baseline.outputTokens),
    outputTokenDeltaRate: finiteDeltaRate(candidate.outputTokens, baseline.outputTokens),
    durationDeltaMs: finiteDelta(candidate.durationMs, baseline.durationMs),
    durationDeltaRate: finiteDeltaRate(candidate.durationMs, baseline.durationMs),
    toolCallDelta: finiteDelta(candidate.toolCalls, baseline.toolCalls),
    toolCallDeltaRate: finiteDeltaRate(candidate.toolCalls, baseline.toolCalls),
    runtimeContextTreatment: args.candidateContextPackets
      ? { baseline: 'legacy_model_routed', candidate: 'packet_supplied' }
      : null,
    runEvidence: runs.map((run) => ({
      variant: run.variant,
      scenarioId: run.scenarioId,
      repetition: run.repetition,
      metadata: path.relative(PROJECT_ROOT, run.files.metadata),
      metadataSha256: sha256(readFileSync(run.files.metadata)),
      grade: path.relative(PROJECT_ROOT, run.files.grade),
      gradeSha256: sha256(readFileSync(run.files.grade)),
      initialGrade: statSafe(run.files.initialGrade) ? path.relative(PROJECT_ROOT, run.files.initialGrade) : null,
      initialGradeSha256: statSafe(run.files.initialGrade) ? sha256(readFileSync(run.files.initialGrade)) : null,
      result: path.relative(PROJECT_ROOT, run.files.result),
      resultSha256: statSafe(run.files.result) ? sha256(readFileSync(run.files.result)) : null,
    })),
  };
}

function buildInstrumentedSummary(args, scenarios, runs, source, contractHash, schemaHash) {
  const variant = 'instrumented-current';
  const aggregateMetrics = aggregate(runs, variant);
  const comparisons = scenarios.map((scenario) => ({
    scenarioId: scenario.id,
    metrics: aggregate(runs, variant, scenario.id),
  }));
  const coverageComplete = runs.length === scenarios.length * args.repetitions;
  const measurementComplete = aggregateMetrics.measurementCoverage.complete;
  const candidateAllPass = runs.every((run) => run.grade?.verdict === 'pass');
  const traceComplete = aggregateMetrics.traceCoverage.complete;
  return {
    schema_version: 'p2a.context_engineering_codex_trace_summary.v1',
    evaluationId: args.evaluationId,
    generatedAt: new Date().toISOString(),
    scope: {
      provider: 'codex',
      model: args.model,
      reasoning: args.reasoning,
      repetitions: args.repetitions,
      scenarios: scenarios.map((scenario) => scenario.id),
      changeUnit: 'instrumented current-candidate baseline before runtime routing product changes',
      limitations: [
        'Historical CE-009 runs have no trajectory and are not backfilled or compared as zero.',
        'Claude and Gemini provider coverage is absent.',
      ],
    },
    source,
    contractSha256: contractHash,
    outputSchemaSha256: schemaHash,
    metrics: aggregateMetrics,
    scenarios: comparisons,
    coverageComplete,
    measurementComplete,
    candidateAllPass,
    traceComplete,
    providerVerdict: !coverageComplete || !measurementComplete || !traceComplete
      ? 'inconclusive'
      : candidateAllPass ? 'provider_limited' : 'no_go',
    runEvidence: runs.map((run) => ({
      scenarioId: run.scenarioId,
      repetition: run.repetition,
      metadata: path.relative(PROJECT_ROOT, run.files.metadata),
      metadataSha256: sha256(readFileSync(run.files.metadata)),
      grade: path.relative(PROJECT_ROOT, run.files.grade),
      gradeSha256: sha256(readFileSync(run.files.grade)),
      result: path.relative(PROJECT_ROOT, run.files.result),
      resultSha256: statSafe(run.files.result) ? sha256(readFileSync(run.files.result)) : null,
    })),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  args.baseline = args.baseline ? path.resolve(args.baseline) : null;
  args.candidate = path.resolve(args.candidate);
  args.contract = path.resolve(args.contract);
  args.schema = path.resolve(args.schema);
  args.output = path.resolve(args.output);
  args.regradeFrom = args.regradeFrom ? path.resolve(args.regradeFrom) : null;
  args.performanceReference = args.performanceReference ? path.resolve(args.performanceReference) : null;
  const sourceInputs = args.instrumentedCurrent
    ? [['candidate', args.candidate]]
    : [['baseline', args.baseline], ['candidate', args.candidate]];
  for (const [label, value] of sourceInputs) {
    let status;
    try {
      status = statSync(value);
    } catch {
      fail(`${label} source is missing: ${value}`);
    }
    if (!status.isDirectory()) fail(`${label} source must be a directory: ${value}`);
  }
  if (args.regradeFrom) {
    let status;
    try {
      status = statSync(args.regradeFrom);
    } catch {
      fail(`regrade source is missing: ${args.regradeFrom}`);
    }
    if (!status.isDirectory()) fail(`regrade source must be a directory: ${args.regradeFrom}`);
    if (args.regradeFrom === args.output) fail('--regrade-from and --output must be distinct');
  }
  if (!args.output.startsWith(`${PROJECT_ROOT}${path.sep}`)) fail('output must stay inside the Plan2Agent repository');
  const loadedContract = loadEvaluationContract(args.contract);
  const contract = loadedContract.contract;
  const schema = readJson(args.schema, 'output schema');
  args.evaluationId ??= loadedContract.evaluationId ?? 'ce-009-codex-aggregate-2026-08-15';
  if (schema.title !== 'Plan2Agent context engineering Codex A/B result') fail('unexpected output schema');
  let scenarios = contract.scenarios;
  if (args.scenarios.length) {
    const selectedIds = new Set(args.scenarios);
    scenarios = scenarios.filter((scenario) => selectedIds.has(scenario.id));
    const unknownIds = args.scenarios.filter((id) => !scenarios.some((scenario) => scenario.id === id));
    if (unknownIds.length) fail(`unknown scenario(s): ${unknownIds.join(', ')}`);
  }
  if (!scenarios.length) fail('contract has no scenarios');
  if (args.performanceReference) {
    args.performanceReferenceSummary = validatePerformanceReference(
      readJson(args.performanceReference, 'performance reference'),
      {
        provider: 'codex',
        model: args.model,
        reasoning: args.reasoning,
        repetitions: args.repetitions,
        scenarios: scenarios.map((scenario) => scenario.id),
      },
    );
  }
  const contractHash = loadedContract.sha256;
  const schemaHash = sha256(readFileSync(args.schema));
  const sources = {
    ...(args.instrumentedCurrent ? {} : { baseline: {
      snapshotRef: args.candidateContextPackets
        ? 'current-source-legacy-routing-control'
        : 'temporary-baseline-snapshot',
      commitSha: args.candidateContextPackets ? null : args.baselineCommit,
      ...(args.candidateContextPackets ? {
        baseCommitSha: args.candidateBaseCommit,
        dirtyPatchSha256: args.candidatePatchSha,
        untrackedManifestSha256: args.candidateUntrackedSha,
      } : {}),
      dirty: args.candidateContextPackets,
      ...sourceManifest(args.baseline),
    } }),
    candidate: {
      snapshotRef: args.candidateContextPackets
        ? 'current-source-packet-treatment'
        : 'temporary-candidate-snapshot',
      commitSha: null,
      baseCommitSha: args.candidateBaseCommit,
      dirtyPatchSha256: args.candidatePatchSha,
      untrackedManifestSha256: args.candidateUntrackedSha,
      dirty: true,
      ...sourceManifest(args.candidate),
    },
  };
  if (
    args.candidateContextPackets
    && (
      sources.baseline.sha256 !== sources.candidate.sha256
      || sources.baseline.files !== sources.candidate.files
    )
  ) {
    fail('runtime context feature-toggle A/B requires byte-identical baseline and candidate source trees');
  }
  const plannedRuns = scenarios.length * args.repetitions * (args.instrumentedCurrent ? 1 : 2);
  console.log(`matrix scenarios=${scenarios.length} repetitions=${args.repetitions} runs=${plannedRuns} model=${args.model}/${args.reasoning}`);
  if (sources.baseline) console.log(`baseline sha256=${sources.baseline.sha256} files=${sources.baseline.files}`);
  console.log(`candidate sha256=${sources.candidate.sha256} files=${sources.candidate.files}`);
  if (args.dryRun) {
    if (args.candidateContextPackets) {
      for (const scenario of scenarios) {
        const fixture = buildRuntimeContextFixture(args.candidate, scenario);
        console.log(`candidate context ${scenario.id}: ${fixture ? fixture.metadata.routeIds.join(',') : 'not-applicable'}`);
      }
    }
    return;
  }

  const runs = [];
  for (const scenario of scenarios) {
    for (let repetition = 1; repetition <= args.repetitions; repetition += 1) {
      if (args.instrumentedCurrent) {
        const run = await executeOne({
          args,
          scenario,
          variant: 'instrumented-current',
          sourceRoot: args.candidate,
          source: sources.candidate,
          contractHash,
          schemaHash,
          repetition,
        });
        runs.push(run);
        if (run.metadata?.execution?.toolTrace?.status !== 'available') {
          fail(`sanitized trace preflight failed for ${scenario.id}/run-${repetition}; adjust event parsing before product changes`);
        }
        if (runs.length === 1) console.log('sanitized trace preflight: supported');
      } else {
        const pair = await Promise.all([
          executeOne({ args, scenario, variant: 'baseline', sourceRoot: args.baseline, source: sources.baseline, contractHash, schemaHash, repetition }),
          executeOne({ args, scenario, variant: 'candidate', sourceRoot: args.candidate, source: sources.candidate, contractHash, schemaHash, repetition }),
        ]);
        runs.push(...pair);
      }
    }
  }
  const recordedSources = runs
    .map((run) => run.metadata?.source)
    .filter((item) => item && typeof item === 'object');
  const recordedSourceKeys = new Set(recordedSources.map((item) => stableJson(item)));
  if (args.regradeFrom && recordedSourceKeys.size !== 1) {
    fail('regrade source evidence must use one consistent source manifest');
  }
  const summarySource = args.regradeFrom ? recordedSources[0] : sources.candidate;
  const summary = args.instrumentedCurrent
    ? buildInstrumentedSummary(args, scenarios, runs, summarySource, contractHash, schemaHash)
    : buildSummary(args, scenarios, runs, sources, contractHash, schemaHash);
  const summaryPath = path.join(
    args.output,
    'codex',
    args.instrumentedCurrent ? 'codex-trace-summary.json' : 'codex-ab-summary.json',
  );
  writeJson(summaryPath, summary);
  console.log(`summary ${path.relative(PROJECT_ROOT, summaryPath)} verdict=${summary.providerVerdict}`);
}

await main();
