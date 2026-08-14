#!/usr/bin/env node
/** Execute the approved adaptive A/B fixture matrix with provider-owned implementation evidence. */

import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const EVAL_ROOT = path.dirname(SCRIPT_PATH);
const ROOT = path.resolve(EVAL_ROOT, '..', '..');
const DEFAULT_MANIFEST = path.join(EVAL_ROOT, 'manifest.json');
const VISUAL_SCHEMA = path.join(EVAL_ROOT, 'visual-review-output.schema.json');
const DEFAULT_MODEL = 'gpt-5.6-luna';
const DEFAULT_REASONING = 'medium';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CHROME_CAPTURE = path.join(EVAL_ROOT, 'capture_chrome_screenshot.mjs');

function usage() {
  return [
    'Usage:',
    '  node eval/adaptive-ab/run.mjs --execute --output <dir> [options]',
    '  node eval/adaptive-ab/run.mjs --summarize --output <dir>',
    '',
    'Options:',
    '  --manifest <path>       Fixture matrix. Default: eval/adaptive-ab/manifest.json',
    '  --output <dir>          Durable raw events, snapshots, screenshots, and sealed report.',
    '  --work-root <dir>       Persistent isolated workspaces. Default: <output>/workspaces.',
    '  --fixture <id>          Run one fixture. Repeatable.',
    '  --model <id>            Provider model. Default: gpt-5.6-luna',
    '  --reasoning <effort>    Provider reasoning effort. Default: medium',
    '  --max-remediations <n>  Automatic correction attempts per variant. Default: 1',
    '  --execute               Authorize provider calls for selected fixtures.',
    '  --resume                Reuse completed variant evidence and continue.',
    '  --refresh-visual         With --resume, retry only failed visual reviews.',
    '  --summarize             Rebuild the suite report without provider calls.',
  ].join('\n');
}

function requiredValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
  return value;
}

function parseArgs(argv) {
  const args = {
    manifest: DEFAULT_MANIFEST,
    output: null,
    workRoot: null,
    fixtureIds: [],
    model: DEFAULT_MODEL,
    reasoning: DEFAULT_REASONING,
    maxRemediations: 1,
    execute: false,
    resume: false,
    refreshVisual: false,
    summarize: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--manifest') args.manifest = requiredValue(argv, ++index, arg);
    else if (arg === '--output') args.output = requiredValue(argv, ++index, arg);
    else if (arg === '--work-root') args.workRoot = requiredValue(argv, ++index, arg);
    else if (arg === '--fixture') args.fixtureIds.push(requiredValue(argv, ++index, arg));
    else if (arg === '--model') args.model = requiredValue(argv, ++index, arg);
    else if (arg === '--reasoning') args.reasoning = requiredValue(argv, ++index, arg);
    else if (arg === '--max-remediations') args.maxRemediations = Number(requiredValue(argv, ++index, arg));
    else if (arg === '--execute') args.execute = true;
    else if (arg === '--resume') args.resume = true;
    else if (arg === '--refresh-visual') args.refreshVisual = true;
    else if (arg === '--summarize') args.summarize = true;
    else if (arg === '--help' || arg === '-h') return { help: true };
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!args.output) throw new Error('--output is required');
  if (!Number.isInteger(args.maxRemediations) || args.maxRemediations < 0 || args.maxRemediations > 3) {
    throw new Error('--max-remediations must be an integer from 0 to 3');
  }
  if (!args.execute && !args.summarize) throw new Error('pass --execute or --summarize');
  if (args.execute && args.summarize) throw new Error('--execute and --summarize are mutually exclusive');
  if (args.refreshVisual && (!args.execute || !args.resume)) {
    throw new Error('--refresh-visual requires --execute and --resume');
  }
  args.manifest = path.resolve(args.manifest);
  args.output = path.resolve(args.output);
  args.workRoot = path.resolve(args.workRoot ?? path.join(args.output, 'workspaces'));
  return args;
}

function loadJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fileSha256(filePath) {
  return sha256(readFileSync(filePath));
}

function normalizeRelative(value) {
  return value.split(path.sep).join('/');
}

function walkFiles(root, options = {}) {
  if (!existsSync(root)) return [];
  const ignored = new Set(options.ignored ?? []);
  const files = [];
  function visit(current, relative) {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const nextRelative = relative ? path.join(relative, entry.name) : entry.name;
      const normalized = normalizeRelative(nextRelative);
      if ([...ignored].some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`))) continue;
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) visit(next, nextRelative);
      else if (entry.isFile()) files.push({ path: next, relative: normalized });
    }
  }
  visit(root, '');
  return files;
}

function fileInventory(root, options = {}) {
  return walkFiles(root, options).map((item) => ({
    path: item.relative,
    sha256: fileSha256(item.path),
    bytes: statSync(item.path).size,
  }));
}

export function changedFiles(before, after) {
  const beforeMap = new Map(before.map((item) => [item.path, item.sha256]));
  const afterMap = new Map(after.map((item) => [item.path, item.sha256]));
  return [...new Set([...beforeMap.keys(), ...afterMap.keys()])]
    .filter((filePath) => beforeMap.get(filePath) !== afterMap.get(filePath))
    .sort();
}

export function parseCodexJsonl(stdout) {
  const events = String(stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'))
    .flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  const usage = events
    .filter((event) => event.type === 'turn.completed' && event.usage)
    .reduce((total, event) => ({
      input_tokens: total.input_tokens + Number(event.usage.input_tokens ?? 0),
      cached_input_tokens: total.cached_input_tokens + Number(event.usage.cached_input_tokens ?? 0),
      output_tokens: total.output_tokens + Number(event.usage.output_tokens ?? 0),
      reasoning_output_tokens: total.reasoning_output_tokens + Number(event.usage.reasoning_output_tokens ?? 0),
    }), { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 });
  const messages = events
    .filter((event) => event.type === 'item.completed' && event.item?.type === 'agent_message')
    .map((event) => event.item.text);
  return { events, usage, finalMessage: messages.at(-1) ?? '' };
}

function commandResult(command, workspace, extraEnv = {}) {
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const result = spawnSync(command, {
    cwd: workspace,
    encoding: 'utf8',
    shell: true,
    maxBuffer: 1024 * 1024 * 10,
    env: { ...process.env, ...extraEnv },
  });
  return {
    command,
    status: result.status === 0 ? 'passed' : 'failed',
    exit_code: typeof result.status === 'number' ? result.status : 1,
    started_at: startedAt,
    duration_ms: Date.now() - start,
    stdout_tail: String(result.stdout ?? '').slice(-6000),
    stderr_tail: [result.stderr, result.error?.message].filter(Boolean).join('\n').slice(-6000),
  };
}

function codexPrompt({ fixture, variant, task = null, remediation = null }) {
  const boundary = [
    'You are the implementation owner in a controlled A/B benchmark.',
    'Work only in the current workspace. Do not use network access or install dependencies.',
    'Do not modify tests, hidden acceptance files, or evaluation metadata.',
    `Only these implementation paths may change: ${fixture.allowed_paths.join(', ')}.`,
    'Preserve public exports and existing behavior outside the objective.',
    'Do not ask the user to choose implementation details. Inspect, implement, run the stated verification, and correct ordinary failures autonomously.',
  ].join(' ');
  if (remediation) {
    return `${boundary}\n\nApproved objective:\n${fixture.objective}\n\nThe previous attempt failed verification. Diagnose and correct it without broadening scope.\n\nFailure evidence:\n${remediation}`;
  }
  if (variant === 'a') {
    return `${boundary}\n\nApproved full objective (read for boundaries):\n${fixture.objective}\n\nCurrent pre-authored work item ${task.id}:\n${task.objective}\n\nRequired verification for this work item:\n${task.verification}\n\nImplement only this routed work item, while preserving compatible work already present.`;
  }
  return `${boundary}\n\nOwn this complete approved objective through implementation and verification:\n${fixture.objective}\n\nRequired complete verification:\n${fixture.verification.join('\n')}\n\nChoose the smallest suitable internal execution strategy. Begin the final response with exactly MODE: direct, MODE: planned, or MODE: orchestrated, followed by a concise implementation and verification summary.`;
}

export function codexExecArgs({
  workspace,
  prompt,
  model,
  reasoning,
  images = [],
  outputSchema = null,
  sandbox = null,
}) {
  const sandboxMode = sandbox ?? (images.length ? 'read-only' : 'workspace-write');
  const args = [
    'exec', '--ephemeral', '--json', '--skip-git-repo-check', '--sandbox', sandboxMode,
    '-C', workspace, '-m', model, '-c', `model_reasoning_effort="${reasoning}"`,
  ];
  if (outputSchema) args.push('--output-schema', outputSchema);
  for (const image of images) args.push('-i', image);
  // `--image <FILE>...` is variadic. The separator prevents clap from consuming
  // the positional prompt as one more image path.
  args.push('--', prompt);
  return args;
}

function runCodex({ workspace, prompt, model, reasoning, images = [], outputSchema = null, sandbox = null }) {
  const args = codexExecArgs({ workspace, prompt, model, reasoning, images, outputSchema, sandbox });
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const result = spawnSync('codex', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 50,
    env: process.env,
  });
  const parsed = parseCodexJsonl(result.stdout);
  return {
    status: result.status === 0 ? 'completed' : 'failed',
    exit_code: typeof result.status === 'number' ? result.status : 1,
    started_at: startedAt,
    duration_ms: Date.now() - start,
    usage: parsed.usage,
    final_message: parsed.finalMessage,
    stdout: result.stdout ?? '',
    stderr: [result.stderr, result.error?.message].filter(Boolean).join('\n'),
  };
}

function sumUsage(calls) {
  return calls.reduce((total, call) => ({
    input_tokens: total.input_tokens + call.usage.input_tokens,
    cached_input_tokens: total.cached_input_tokens + call.usage.cached_input_tokens,
    output_tokens: total.output_tokens + call.usage.output_tokens,
    reasoning_output_tokens: total.reasoning_output_tokens + call.usage.reasoning_output_tokens,
  }), { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 });
}

function decisionInterruptions(calls) {
  return calls.filter((call) => (
    /(?:need|require).{0,30}(?:clarification|decision)|GATE_RETURN/i.test(call.final_message)
    || /\?\s*$/.test(call.final_message.trim())
  )).length;
}

function selectedMode(call) {
  return /^MODE:\s*(direct|planned|orchestrated)\b/im.exec(call?.final_message ?? '')?.[1] ?? null;
}

function captureScreenshots(fixture, workspace, outputDir) {
  if (!fixture.screenshots?.length) return [];
  if (!existsSync(CHROME) || !lstatSync(CHROME).isFile()) {
    return fixture.screenshots.map((screen) => ({ ...screen, status: 'failed', error: 'Google Chrome executable is unavailable' }));
  }
  const screenshots = [];
  for (const [index, screen] of fixture.screenshots.entries()) {
    mkdirSync(outputDir, { recursive: true });
    const fileName = `${String(index + 1).padStart(2, '0')}-${screen.state}-${screen.width}x${screen.height}.png`;
    const filePath = path.join(outputDir, fileName);
    const query = fixture.id === 'multi-state-status-ui' ? `?state=${encodeURIComponent(screen.state)}` : '';
    const url = `${pathToFileURL(path.join(workspace, 'index.html')).href}${query}`;
    const result = spawnSync(process.execPath, [
      CHROME_CAPTURE,
      '--chrome', CHROME,
      '--url', url,
      '--output', filePath,
      '--width', String(screen.width),
      '--height', String(screen.height),
    ], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 5 });
    screenshots.push({
      ...screen,
      status: result.status === 0 && existsSync(filePath) ? 'captured' : 'failed',
      file: existsSync(filePath) ? normalizeRelative(path.relative(outputDir, filePath)) : null,
      sha256: existsSync(filePath) ? fileSha256(filePath) : null,
      bytes: existsSync(filePath) ? statSync(filePath).size : null,
      error: result.status === 0 ? null : [result.stderr, result.error?.message].filter(Boolean).join('\n').slice(-2000),
    });
  }
  return screenshots;
}

function archiveScreenshots(screenshotDir, screenshots, attempt) {
  const historyDir = path.join(screenshotDir, 'history', `attempt-${attempt}`);
  for (const screenshot of screenshots ?? []) {
    if (!screenshot.file) continue;
    const source = path.join(screenshotDir, screenshot.file);
    if (!existsSync(source)) continue;
    const destination = path.join(historyDir, screenshot.file);
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(source, destination);
  }
  return normalizeRelative(path.relative(screenshotDir, historyDir));
}

function screenshotPaths(screenshotDir, screenshots) {
  return (screenshots ?? [])
    .filter((screenshot) => screenshot.status === 'captured' && screenshot.file)
    .map((screenshot) => path.join(screenshotDir, screenshot.file));
}

function visualRemediationEvidence(review) {
  return [
    'Automated browser visual acceptance failed.',
    `Verdict: ${review?.verdict ?? 'fail'}`,
    `Observable drift count: ${review?.drift_count ?? 1}`,
    `Reviewer note: ${review?.note ?? 'No reviewer note was returned.'}`,
    'Use the attached rendered screenshots as evidence. Correct the implementation, rerun the required verification, and do not modify tests.',
  ].join('\n');
}

function visualReview(fixture, workspace, screenshotDir, screenshots, model, reasoning) {
  if (!fixture.screenshots?.length) return { review: null, call: null };
  const captured = screenshots.filter((item) => item.status === 'captured' && item.file);
  if (captured.length !== fixture.screenshots.length) {
    return { review: { verdict: 'fail', drift_count: fixture.screenshots.length - captured.length, note: 'Screenshot capture was incomplete.' }, call: null };
  }
  const images = captured.map((item) => path.join(screenshotDir, item.file));
  const prompt = [
    'Independently review these rendered benchmark screenshots against the approved visual objective below.',
    'Count only observable visual drift: clipped or overflowing content, unreadable hierarchy, broken responsive layout, missing visible state distinction, or unusable focus/action presentation.',
    'Do not demand pixel matching or invent requirements. Return the schema object only.',
    `Objective: ${fixture.objective}`,
    `Cases: ${captured.map((item) => `${item.state}@${item.width}x${item.height}`).join(', ')}`,
  ].join('\n');
  const call = runCodex({ workspace, prompt, model, reasoning, images, outputSchema: VISUAL_SCHEMA });
  let review;
  try {
    review = JSON.parse(call.final_message);
  } catch {
    review = { verdict: 'fail', drift_count: captured.length, note: 'Visual reviewer did not return valid structured output.' };
  }
  return { review, call };
}

function variantEvidencePath(output, fixtureId, variant) {
  return path.join(output, 'fixtures', fixtureId, variant, 'variant.json');
}

function variantComplete(output, fixtureId, variant) {
  const filePath = variantEvidencePath(output, fixtureId, variant);
  if (!existsSync(filePath)) return null;
  const payload = loadJson(filePath);
  return payload.status === 'complete' ? payload : null;
}

function callSummary(call) {
  return {
    status: call.status,
    exit_code: call.exit_code,
    started_at: call.started_at,
    duration_ms: call.duration_ms,
    usage: call.usage,
    final_message: call.final_message,
  };
}

function executeVisualLoop({
  fixture,
  fixtureRoot,
  variant,
  workspace,
  screenshotDir,
  callDir,
  calls,
  model,
  reasoning,
  maxRemediations,
  finalVerification,
  remediationRuns = 0,
  screenshots = [],
  visualAttempts = [],
  archiveInitialScreenshots = false,
  reviewCallId,
}) {
  if (archiveInitialScreenshots && screenshots.length) {
    const historyRef = archiveScreenshots(screenshotDir, screenshots, visualAttempts.length + 1);
    if (visualAttempts.length) visualAttempts.at(-1).screenshot_ref = historyRef;
  }

  let currentScreenshots = captureScreenshots(fixture, workspace, screenshotDir);
  let visual = visualReview(fixture, workspace, screenshotDir, currentScreenshots, model, reasoning);
  let visualRemediationApplied = false;

  function recordVisualCall() {
    if (!visual.call) return;
    const attemptNumber = visualAttempts.length + 1;
    const summary = rawCallRecord(
      visual.call,
      callDir,
      reviewCallId({ attemptNumber, remediationRuns }),
    );
    calls.push(summary);
    visualAttempts.push({ ...summary, superseded: false, screenshot_ref: 'screenshots' });
  }

  recordVisualCall();
  const firstVisualPassed = !visual.review || visual.review.verdict === 'pass';
  while (visual.review?.verdict === 'fail' && remediationRuns < maxRemediations) {
    remediationRuns += 1;
    visualRemediationApplied = true;
    const remediation = runCodex({
      workspace,
      prompt: codexPrompt({ fixture, variant, remediation: visualRemediationEvidence(visual.review) }),
      model,
      reasoning,
      images: screenshotPaths(screenshotDir, currentScreenshots),
      sandbox: 'workspace-write',
    });
    calls.push(rawCallRecord(remediation, callDir, `visual-remediation-${remediationRuns}`));
    finalVerification = fixture.verification.map((command) => commandResult(command, workspace));
    const heldOut = heldOutVerification(fixture, fixtureRoot, workspace);
    if (heldOut) finalVerification.push(heldOut);
    const historyRef = archiveScreenshots(screenshotDir, currentScreenshots, visualAttempts.length + 1);
    if (visualAttempts.length) {
      visualAttempts.at(-1).superseded = true;
      visualAttempts.at(-1).screenshot_ref = historyRef;
    }
    currentScreenshots = captureScreenshots(fixture, workspace, screenshotDir);
    visual = visualReview(fixture, workspace, screenshotDir, currentScreenshots, model, reasoning);
    recordVisualCall();
  }

  return {
    screenshots: currentScreenshots,
    review: visual.review,
    visualAttempts,
    firstVisualPassed,
    visualRemediationApplied,
    remediationRuns,
    finalVerification,
  };
}

function refreshVisualVariant(existing, fixture, fixtureRoot, variant, args) {
  if (!fixture.screenshots?.length || existing.visual?.passed) return existing;
  const evidenceDir = path.join(args.output, 'fixtures', fixture.id, variant);
  const callDir = path.join(evidenceDir, 'calls');
  const screenshotDir = path.join(evidenceDir, 'screenshots');
  const snapshotDir = path.join(evidenceDir, 'snapshot');
  const workspace = path.join(args.workRoot, fixture.id, variant);
  materializeWorkspace(snapshotDir, workspace);
  const failedProviderCalls = existing.execution.provider_calls.filter((call) => (
    call.status !== 'completed' || call.usage.input_tokens <= 0 || call.usage.output_tokens <= 0
  ));
  const completedProviderCalls = existing.execution.provider_calls.filter((call) => (
    call.status === 'completed' && call.usage.input_tokens > 0 && call.usage.output_tokens > 0
  ));
  const newCalls = [];
  const visualAttempts = (existing.visual?.attempts ?? failedProviderCalls).map((attempt) => ({
    ...attempt,
    superseded: true,
  }));
  const invalidCaptureRemediations = existing.visual?.capture_contract === 'exact-css-viewport-v1'
    ? 0
    : existing.execution.remediation_runs;
  const visualResult = executeVisualLoop({
    fixture,
    fixtureRoot,
    variant,
    workspace,
    screenshotDir,
    callDir,
    calls: newCalls,
    model: args.model,
    reasoning: args.reasoning,
    maxRemediations: args.maxRemediations,
    finalVerification: existing.verification.final_checks,
    remediationRuns: Math.max(0, existing.execution.remediation_runs - invalidCaptureRemediations),
    screenshots: existing.visual?.screenshots ?? [],
    visualAttempts,
    archiveInitialScreenshots: true,
    reviewCallId: ({ attemptNumber }) => `visual-review-retry-${attemptNumber}`,
  });
  const {
    screenshots,
    review,
    visualRemediationApplied,
    remediationRuns,
    finalVerification,
  } = visualResult;

  const finalInventory = fileInventory(workspace);
  const changed = changedFiles(existing.workspace.initial_inventory, finalInventory);
  const scopeViolations = changed.filter((filePath) => !fixture.allowed_paths.includes(filePath));
  if (visualRemediationApplied) {
    if (existsSync(snapshotDir)) rmSync(snapshotDir, { recursive: true, force: true });
    cpSync(workspace, snapshotDir, { recursive: true });
  }
  const refreshedCalls = [...completedProviderCalls, ...newCalls];
  const visualPassed = !review || review.verdict === 'pass';
  const providerCallsComplete = refreshedCalls.every((call) => (
    call.status === 'completed' && call.usage.input_tokens > 0 && call.usage.output_tokens > 0
  ));
  const verificationPassed = verificationFailures(finalVerification).length === 0;
  const refreshed = {
    ...existing,
    execution: {
      ...existing.execution,
      provider_calls: refreshedCalls,
      provider_calls_complete: providerCallsComplete,
      usage: sumUsage(refreshedCalls),
      elapsed_ms: existing.execution.elapsed_ms + newCalls.reduce((sum, call) => sum + call.duration_ms, 0),
      completed_at: new Date().toISOString(),
      remediation_runs: remediationRuns,
      infrastructure_retry_runs: (existing.execution.infrastructure_retry_runs ?? 0) + invalidCaptureRemediations,
    },
    verification: {
      ...existing.verification,
      final_checks: finalVerification,
      first_pass_accepted: false,
      passed: verificationPassed,
      evidence_complete: finalVerification.length > 0
        && finalVerification.every((result) => Number.isInteger(result.exit_code)),
    },
    monitor: {
      ...existing.monitor,
      changed_files: changed,
      scope_violations: scopeViolations,
      rule_violations: scopeViolations.map((filePath) => `protected path changed: ${filePath}`),
      passed: scopeViolations.length === 0,
    },
    visual: {
      ...existing.visual,
      screenshots,
      review,
      passed: visualPassed,
      drift_count: review?.drift_count ?? 0,
      attempts: visualAttempts,
      capture_contract: 'exact-css-viewport-v1',
    },
    result: {
      accepted: verificationPassed
        && visualPassed
        && scopeViolations.length === 0
        && providerCallsComplete,
    },
    workspace: {
      ...existing.workspace,
      final_inventory: finalInventory,
    },
  };
  writeJson(variantEvidencePath(args.output, fixture.id, variant), refreshed);
  return refreshed;
}

function materializeWorkspace(fixtureRoot, workspace) {
  if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true });
  mkdirSync(workspace, { recursive: true });
  for (const entry of readdirSync(fixtureRoot, { withFileTypes: true })) {
    if (entry.name === '.acceptance') continue;
    cpSync(path.join(fixtureRoot, entry.name), path.join(workspace, entry.name), { recursive: true });
  }
}

function rawCallRecord(call, callDir, callId) {
  mkdirSync(callDir, { recursive: true });
  writeFileSync(path.join(callDir, `${callId}.jsonl`), call.stdout, 'utf8');
  writeFileSync(path.join(callDir, `${callId}.stderr.txt`), call.stderr, 'utf8');
  const { stdout, stderr, ...summary } = call;
  writeJson(path.join(callDir, `${callId}.json`), summary);
  return summary;
}

function heldOutVerification(fixture, fixtureRoot, workspace) {
  if (!fixture.held_out_test) return null;
  const heldOutPath = path.join(fixtureRoot, fixture.held_out_test);
  return commandResult(`node ${JSON.stringify(heldOutPath)}`, workspace, { P2A_AB_WORKSPACE: workspace });
}

function verificationFailures(results) {
  return results.filter((result) => result.status !== 'passed');
}

function failureEvidence(results) {
  return verificationFailures(results)
    .map((result) => `$ ${result.command}\n${result.stdout_tail}\n${result.stderr_tail}`)
    .join('\n\n')
    .slice(-12000);
}

function executeVariant({ fixture, fixtureRoot, variant, args }) {
  const existing = args.resume ? variantComplete(args.output, fixture.id, variant) : null;
  if (existing) {
    return args.refreshVisual
      ? refreshVisualVariant(existing, fixture, fixtureRoot, variant, args)
      : existing;
  }
  const workspace = path.join(args.workRoot, fixture.id, variant);
  const evidenceDir = path.join(args.output, 'fixtures', fixture.id, variant);
  const callDir = path.join(evidenceDir, 'calls');
  materializeWorkspace(fixtureRoot, workspace);
  const initialInventory = fileInventory(workspace);
  const calls = [];
  const taskVerifications = [];
  const startedAt = new Date().toISOString();
  const start = Date.now();

  if (variant === 'a') {
    for (const [index, task] of fixture.a_tasks.entries()) {
      const call = runCodex({
        workspace,
        prompt: codexPrompt({ fixture, variant, task }),
        model: args.model,
        reasoning: args.reasoning,
      });
      calls.push(rawCallRecord(call, callDir, `task-${String(index + 1).padStart(2, '0')}-${task.id}`));
      taskVerifications.push(commandResult(task.verification, workspace));
    }
  } else {
    const call = runCodex({
      workspace,
      prompt: codexPrompt({ fixture, variant }),
      model: args.model,
      reasoning: args.reasoning,
    });
    calls.push(rawCallRecord(call, callDir, 'objective'));
  }

  let finalVerification = fixture.verification.map((command) => commandResult(command, workspace));
  const heldOut = heldOutVerification(fixture, fixtureRoot, workspace);
  if (heldOut) finalVerification.push(heldOut);
  const firstPassAccepted = verificationFailures(finalVerification).length === 0;
  const integrationDefects = variant === 'a'
    && taskVerifications.every((result) => result.status === 'passed')
    && !firstPassAccepted ? 1 : 0;
  let remediationRuns = 0;
  while (verificationFailures(finalVerification).length && remediationRuns < args.maxRemediations) {
    remediationRuns += 1;
    const call = runCodex({
      workspace,
      prompt: codexPrompt({ fixture, variant, remediation: failureEvidence(finalVerification) }),
      model: args.model,
      reasoning: args.reasoning,
    });
    calls.push(rawCallRecord(call, callDir, `remediation-${remediationRuns}`));
    finalVerification = fixture.verification.map((command) => commandResult(command, workspace));
    const retryHeldOut = heldOutVerification(fixture, fixtureRoot, workspace);
    if (retryHeldOut) finalVerification.push(retryHeldOut);
  }

  const visualAttempts = [];
  const screenshotDir = path.join(evidenceDir, 'screenshots');
  const visualResult = executeVisualLoop({
    fixture,
    fixtureRoot,
    variant,
    workspace,
    screenshotDir,
    callDir,
    calls,
    model: args.model,
    reasoning: args.reasoning,
    maxRemediations: args.maxRemediations,
    finalVerification,
    remediationRuns,
    visualAttempts,
    reviewCallId: ({ attemptNumber, remediationRuns: currentRemediationRuns }) => (
      attemptNumber === 1
        ? 'visual-review'
        : `visual-review-after-remediation-${currentRemediationRuns}`
    ),
  });
  const {
    screenshots,
    review,
    firstVisualPassed,
  } = visualResult;
  ({ finalVerification, remediationRuns } = visualResult);
  const finalInventory = fileInventory(workspace);
  const changed = changedFiles(initialInventory, finalInventory);
  const scopeViolations = changed.filter((filePath) => !fixture.allowed_paths.includes(filePath));
  const snapshotDir = path.join(evidenceDir, 'snapshot');
  if (existsSync(snapshotDir)) rmSync(snapshotDir, { recursive: true, force: true });
  cpSync(workspace, snapshotDir, { recursive: true });
  const completedAt = new Date().toISOString();
  const providerCallsComplete = calls.every((call) => (
    call.status === 'completed'
    && call.usage.input_tokens > 0
    && call.usage.output_tokens > 0
  ));
  const verificationPassed = verificationFailures(finalVerification).length === 0;
  const visualPassed = !review || review.verdict === 'pass';
  const evidence = {
    schema_version: 'p2a.adaptive_ab_variant.v1',
    fixture_id: fixture.id,
    fixture_kind: fixture.kind,
    variant,
    status: 'complete',
    model_profile: `${args.model}/${args.reasoning}`,
    objective: fixture.objective,
    source: {
      fixture_path: normalizeRelative(path.relative(ROOT, fixtureRoot)),
      fixture_inventory: fileInventory(fixtureRoot),
      fixture_sha256: sha256(JSON.stringify(fileInventory(fixtureRoot))),
    },
    execution: {
      task_count: variant === 'a' ? fixture.a_tasks.length : 1,
      selected_mode: variant === 'b' ? selectedMode(calls[0]) : 'orchestrated',
      provider_calls: calls.map(callSummary),
      provider_calls_complete: providerCallsComplete,
      usage: sumUsage(calls),
      elapsed_ms: Date.now() - start,
      started_at: startedAt,
      completed_at: completedAt,
      implementation_decision_interruptions: decisionInterruptions(calls),
      user_corrections: 0,
      gate_returns: 0,
      remediation_runs: remediationRuns,
      infrastructure_retry_runs: 0,
    },
    verification: {
      task_checks: taskVerifications,
      final_checks: finalVerification,
      first_pass_accepted: firstPassAccepted && firstVisualPassed,
      passed: verificationPassed,
      evidence_complete: finalVerification.length > 0 && finalVerification.every((result) => Number.isInteger(result.exit_code)),
      integration_defects: integrationDefects,
    },
    monitor: {
      changed_files: changed,
      allowed_paths: fixture.allowed_paths,
      scope_violations: scopeViolations,
      rule_violations: scopeViolations.map((filePath) => `protected path changed: ${filePath}`),
      passed: scopeViolations.length === 0,
    },
    visual: {
      screenshots,
      review,
      passed: visualPassed,
      drift_count: review?.drift_count ?? 0,
      attempts: visualAttempts,
      capture_contract: 'exact-css-viewport-v1',
    },
    result: {
      accepted: verificationPassed && visualPassed && scopeViolations.length === 0 && providerCallsComplete,
    },
    workspace: {
      initial_inventory: initialInventory,
      final_inventory: finalInventory,
      snapshot_ref: normalizeRelative(path.relative(args.output, snapshotDir)),
    },
  };
  writeJson(variantEvidencePath(args.output, fixture.id, variant), evidence);
  return evidence;
}

export function comparePair(a, b) {
  const qualityNoWorse = (
    b.result.accepted
    && b.verification.integration_defects <= a.verification.integration_defects
    && b.monitor.scope_violations.length <= a.monitor.scope_violations.length
    && b.monitor.rule_violations.length <= a.monitor.rule_violations.length
    && b.visual.drift_count <= a.visual.drift_count
  );
  const autonomyNoWorse = (
    b.execution.implementation_decision_interruptions <= a.execution.implementation_decision_interruptions
    && b.execution.user_corrections <= a.execution.user_corrections
    && b.execution.gate_returns <= a.execution.gate_returns
  );
  return {
    status: a.result.accepted && qualityNoWorse && autonomyNoWorse ? 'pass' : 'fail',
    task_count: { a: a.execution.task_count, b: b.execution.task_count, delta: b.execution.task_count - a.execution.task_count },
    provider_calls: { a: a.execution.provider_calls.length, b: b.execution.provider_calls.length, delta: b.execution.provider_calls.length - a.execution.provider_calls.length },
    input_tokens: { a: a.execution.usage.input_tokens, b: b.execution.usage.input_tokens, delta: b.execution.usage.input_tokens - a.execution.usage.input_tokens },
    output_tokens: { a: a.execution.usage.output_tokens, b: b.execution.usage.output_tokens, delta: b.execution.usage.output_tokens - a.execution.usage.output_tokens },
    elapsed_ms: { a: a.execution.elapsed_ms, b: b.execution.elapsed_ms, delta: b.execution.elapsed_ms - a.execution.elapsed_ms },
    first_pass_accepted: { a: a.verification.first_pass_accepted, b: b.verification.first_pass_accepted },
    remediation_runs: { a: a.execution.remediation_runs, b: b.execution.remediation_runs },
    infrastructure_retry_runs: {
      a: a.execution.infrastructure_retry_runs ?? 0,
      b: b.execution.infrastructure_retry_runs ?? 0,
    },
    implementation_decision_interruptions: { a: a.execution.implementation_decision_interruptions, b: b.execution.implementation_decision_interruptions },
    user_corrections: { a: a.execution.user_corrections, b: b.execution.user_corrections },
    integration_defects: { a: a.verification.integration_defects, b: b.verification.integration_defects },
    visual_drift: { a: a.visual.drift_count, b: b.visual.drift_count },
    scope_violations: { a: a.monitor.scope_violations.length, b: b.monitor.scope_violations.length },
    rule_violations: { a: a.monitor.rule_violations.length, b: b.monitor.rule_violations.length },
    verification_evidence_complete: { a: a.verification.evidence_complete, b: b.verification.evidence_complete },
    quality_no_worse: qualityNoWorse,
    autonomy_no_worse: autonomyNoWorse,
  };
}

function suiteInventory(output) {
  return fileInventory(path.join(output, 'fixtures'), { ignored: ['report.json', 'report.md'] });
}

function sumMetric(pairs, selector) {
  return pairs.reduce((sum, pair) => sum + selector(pair), 0);
}

function buildSuiteReport(args, manifest) {
  const fixtures = [];
  for (const fixture of manifest.fixtures) {
    const aPath = variantEvidencePath(args.output, fixture.id, 'a');
    const bPath = variantEvidencePath(args.output, fixture.id, 'b');
    if (!existsSync(aPath) || !existsSync(bPath)) continue;
    const a = loadJson(aPath);
    const b = loadJson(bPath);
    fixtures.push({ fixture_id: fixture.id, kind: fixture.kind, a, b, comparison: comparePair(a, b) });
  }
  const complete = fixtures.length === manifest.fixtures.length;
  const allPass = complete && fixtures.every((fixture) => fixture.comparison.status === 'pass');
  const uiPairs = fixtures.filter((fixture) => fixture.kind === 'ui');
  const visualLoopDecision = uiPairs.length > 0
    && uiPairs.every((pair) => (
      pair.b.visual.drift_count <= pair.a.visual.drift_count
      && pair.b.execution.user_corrections <= pair.a.execution.user_corrections
      && pair.b.result.accepted
    )) ? 'remove_task_level_user_visual_approval' : 'retain_task_level_user_visual_approval';
  const inventory = suiteInventory(args.output);
  const report = {
    schema_version: 'p2a.adaptive_ab_report.v1',
    status: allPass ? 'sealed' : complete ? 'failed' : 'incomplete',
    generated_at: new Date().toISOString(),
    model_profile: `${args.model}/${args.reasoning}`,
    manifest_ref: normalizeRelative(path.relative(ROOT, args.manifest)),
    manifest_sha256: fileSha256(args.manifest),
    fixture_count: { required: manifest.fixtures.length, completed: fixtures.length },
    fixtures: fixtures.map((fixture) => ({
      fixture_id: fixture.fixture_id,
      kind: fixture.kind,
      comparison: fixture.comparison,
      a_ref: normalizeRelative(path.relative(args.output, variantEvidencePath(args.output, fixture.fixture_id, 'a'))),
      b_ref: normalizeRelative(path.relative(args.output, variantEvidencePath(args.output, fixture.fixture_id, 'b'))),
    })),
    aggregate: {
      task_count: {
        a: sumMetric(fixtures, (pair) => pair.a.execution.task_count),
        b: sumMetric(fixtures, (pair) => pair.b.execution.task_count),
      },
      provider_calls: {
        a: sumMetric(fixtures, (pair) => pair.a.execution.provider_calls.length),
        b: sumMetric(fixtures, (pair) => pair.b.execution.provider_calls.length),
      },
      input_tokens: {
        a: sumMetric(fixtures, (pair) => pair.a.execution.usage.input_tokens),
        b: sumMetric(fixtures, (pair) => pair.b.execution.usage.input_tokens),
      },
      output_tokens: {
        a: sumMetric(fixtures, (pair) => pair.a.execution.usage.output_tokens),
        b: sumMetric(fixtures, (pair) => pair.b.execution.usage.output_tokens),
      },
      elapsed_ms: {
        a: sumMetric(fixtures, (pair) => pair.a.execution.elapsed_ms),
        b: sumMetric(fixtures, (pair) => pair.b.execution.elapsed_ms),
      },
      accepted: {
        a: fixtures.filter((pair) => pair.a.result.accepted).length,
        b: fixtures.filter((pair) => pair.b.result.accepted).length,
      },
      first_pass_accepted: {
        a: fixtures.filter((pair) => pair.a.verification.first_pass_accepted).length,
        b: fixtures.filter((pair) => pair.b.verification.first_pass_accepted).length,
      },
      implementation_decision_interruptions: {
        a: sumMetric(fixtures, (pair) => pair.a.execution.implementation_decision_interruptions),
        b: sumMetric(fixtures, (pair) => pair.b.execution.implementation_decision_interruptions),
      },
      user_corrections: {
        a: sumMetric(fixtures, (pair) => pair.a.execution.user_corrections),
        b: sumMetric(fixtures, (pair) => pair.b.execution.user_corrections),
      },
      rework_runs: {
        a: sumMetric(fixtures, (pair) => pair.a.execution.remediation_runs),
        b: sumMetric(fixtures, (pair) => pair.b.execution.remediation_runs),
      },
      infrastructure_retry_runs: {
        a: sumMetric(fixtures, (pair) => pair.a.execution.infrastructure_retry_runs ?? 0),
        b: sumMetric(fixtures, (pair) => pair.b.execution.infrastructure_retry_runs ?? 0),
      },
      integration_defects: {
        a: sumMetric(fixtures, (pair) => pair.a.verification.integration_defects),
        b: sumMetric(fixtures, (pair) => pair.b.verification.integration_defects),
      },
      visual_drift: {
        a: sumMetric(fixtures, (pair) => pair.a.visual.drift_count),
        b: sumMetric(fixtures, (pair) => pair.b.visual.drift_count),
      },
      scope_violations: {
        a: sumMetric(fixtures, (pair) => pair.a.monitor.scope_violations.length),
        b: sumMetric(fixtures, (pair) => pair.b.monitor.scope_violations.length),
      },
      rule_violations: {
        a: sumMetric(fixtures, (pair) => pair.a.monitor.rule_violations.length),
        b: sumMetric(fixtures, (pair) => pair.b.monitor.rule_violations.length),
      },
    },
    decisions: {
      visual_loop: visualLoopDecision,
      historical_readers: 'retain_for_declared_compatibility_period',
      rationale: 'Historical readers have no active writer but still protect migration and handoff compatibility; removal requires a completed release-period migration audit.',
    },
    evidence_inventory: inventory,
    evidence_inventory_sha256: sha256(JSON.stringify(inventory)),
  };
  writeJson(path.join(args.output, 'report.json'), report);
  const lines = [
    '# Adaptive execution A/B report',
    '',
    `Status: **${report.status}**`,
    '',
    `Model profile: \`${report.model_profile}\``,
    '',
    `Fixtures: ${report.fixture_count.completed}/${report.fixture_count.required}`,
    '',
    '| Fixture | Result | Tasks A→B | Input tokens A→B | First pass A/B | Visual drift A/B |',
    '| --- | --- | ---: | ---: | ---: | ---: |',
    ...report.fixtures.map((fixture) => `| ${fixture.fixture_id} | ${fixture.comparison.status} | ${fixture.comparison.task_count.a}→${fixture.comparison.task_count.b} | ${fixture.comparison.input_tokens.a}→${fixture.comparison.input_tokens.b} | ${fixture.comparison.first_pass_accepted.a}/${fixture.comparison.first_pass_accepted.b} | ${fixture.comparison.visual_drift.a}/${fixture.comparison.visual_drift.b} |`),
    '',
    `Visual-loop decision: \`${report.decisions.visual_loop}\``,
    '',
    `Historical-reader decision: \`${report.decisions.historical_readers}\``,
    '',
    `Evidence inventory SHA-256: \`${report.evidence_inventory_sha256}\``,
    '',
  ];
  writeFileSync(path.join(args.output, 'report.md'), lines.join('\n'), 'utf8');
  return report;
}

function executeSuite(args) {
  const manifest = loadJson(args.manifest);
  if (manifest.schema_version !== 'p2a.adaptive_ab_manifest.v1') throw new Error('unsupported adaptive A/B manifest schema');
  const knownIds = new Set(manifest.fixtures.map((fixture) => fixture.id));
  for (const fixtureId of args.fixtureIds) {
    if (!knownIds.has(fixtureId)) throw new Error(`unknown fixture id: ${fixtureId}`);
  }
  mkdirSync(args.output, { recursive: true });
  mkdirSync(args.workRoot, { recursive: true });
  const selected = args.fixtureIds.length
    ? manifest.fixtures.filter((fixture) => args.fixtureIds.includes(fixture.id))
    : manifest.fixtures;
  for (const fixture of selected) {
    const fixtureRoot = path.resolve(path.dirname(args.manifest), fixture.path);
    if (!existsSync(fixtureRoot)) throw new Error(`fixture path is missing: ${fixtureRoot}`);
    console.log(`A/B fixture ${fixture.id}: A`);
    executeVariant({ fixture, fixtureRoot, variant: 'a', args });
    console.log(`A/B fixture ${fixture.id}: B`);
    executeVariant({ fixture, fixtureRoot, variant: 'b', args });
    buildSuiteReport(args, manifest);
  }
  const report = buildSuiteReport(args, manifest);
  console.log(`Adaptive A/B report: ${path.join(args.output, 'report.json')}`);
  console.log(`- status: ${report.status}`);
  console.log(`- fixtures: ${report.fixture_count.completed}/${report.fixture_count.required}`);
  return report.status === 'sealed' ? 0 : 1;
}

export function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      console.log(usage());
      return 0;
    }
    if (args.summarize) {
      const manifest = loadJson(args.manifest);
      const report = buildSuiteReport(args, manifest);
      console.log(`Adaptive A/B report: ${path.join(args.output, 'report.json')}`);
      console.log(`- status: ${report.status}`);
      return report.status === 'sealed' ? 0 : 1;
    }
    return executeSuite(args);
  } catch (error) {
    console.error(`adaptive A/B failed: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  process.exitCode = main();
}
