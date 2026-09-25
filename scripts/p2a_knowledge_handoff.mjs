#!/usr/bin/env node
/** Freeze selected completed work for an explicit, separately sanitized knowledge import. */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  validateDecisionLedger, validateRunData, validateRunIndexData,
  validateRunTaskContract, validateTaskGraphData, validateSchema, validateSpec, currentDevelopmentContractSha256,
} from './validate_artifacts.mjs';
import {
  auditArchivedIterationArtifacts, resolveCurrentDevelopmentState,
  validateActiveIterationArchiveConsistency,
} from './p2a_iteration_state.mjs';
import {
  canonicalWorkspacePathForArtifactRoot, executionEnvelopeStoreRef,
  immutableTaskContract, RUN_SIDECAR_SUFFIXES, taskContractSha256,
} from './p2a_run_paths.mjs';
import { withRunStoreLocks, runWriteTransactionPath } from './p2a_run_store.mjs';
import {
  assertRunMonitorGateBinding, assertRunMonitorVerdictBinding,
  normalizeMonitorGateSidecar, normalizeMonitorVerdictData,
} from './p2a_monitor_gate.mjs';
import { readRequiredAcceptanceReviewEvidence } from './p2a_acceptance_review_gate.mjs';
import { assertFinalFullVerificationReady } from './p2a_final_verification_gate.mjs';

export const MAX_KNOWLEDGE_HANDOFF_BYTES = 1024 * 1024;
const schemaPath = fileURLToPath(new URL('../schemas/knowledge-handoff-input.schema.json', import.meta.url));
const digest = (body) => `sha256:${createHash('sha256').update(body).digest('hex')}`;
const jsonText = (value) => `${JSON.stringify(value, null, 2)}\n`;
const relative = (root, file) => path.relative(root, file).split(path.sep).join('/');
const safeId = (id) => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) && id !== '..';

function validateTextBounds(value, schema) {
  // The shared minimal runtime validator does not implement maxLength; enforce
  // this transport's string caps explicitly as well as documenting them in JSON Schema.
  if (typeof value === 'string') {
    if (value.includes('\0')) throw new Error('knowledge capture text contains a forbidden NUL character');
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      throw new Error(`knowledge capture text exceeds ${schema.maxLength} characters`);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) validateTextBounds(item, schema.items ?? {});
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) validateTextBounds(item, schema.properties?.[key] ?? {});
  }
}

function inside(root, file) {
  const ref = path.relative(root, file);
  return !ref || (!ref.startsWith(`..${path.sep}`) && ref !== '..' && !path.isAbsolute(ref));
}

function safePath(root, file, { missing = false } = {}) {
  const absolute = path.resolve(file);
  if (!inside(root, absolute)) throw new Error('knowledge capture reference escapes the project');
  // Check ancestors too: lexical containment alone is not a symlink boundary.
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error('knowledge capture rejects symbolic links');
    } catch (error) {
      if (error.code === 'ENOENT' && missing) return absolute;
      throw error;
    }
  }
  return absolute;
}

function artifactRef(root, ref) {
  if (typeof ref !== 'string' || !ref || ref.includes('\\') || path.isAbsolute(ref)
    || /^[A-Za-z]:/.test(ref) || ref.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('knowledge capture requires a safe artifact-relative reference');
  }
  return path.join(root, ref);
}

function publishPrivateFile(projectRoot, file, body) {
  safePath(projectRoot, file, { missing: true });
  if (existsSync(file)) {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_KNOWLEDGE_HANDOFF_BYTES
      || (stat.mode & 0o077) !== 0 || readFileSync(file, 'utf8') !== body) {
      throw new Error('knowledge capture pending file conflicts with its private immutable contents');
    }
    return true;
  }
  // Private from the first write; exclusive publication never replaces a peer's file.
  const temporary = path.join(path.dirname(file), `.${randomUUID()}.pending`);
  let descriptor;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, body, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    safePath(projectRoot, file, { missing: true });
    linkSync(temporary, file);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return false;
}

function createReader(projectRoot, artifactRoot) {
  const reads = new Map();
  const sources = new Map();
  let totalBytes = 0;
  function read(file) {
    const checked = safePath(projectRoot, file);
    if (!inside(artifactRoot, checked)
      && checked !== path.join(projectRoot, '.plan2agent', 'constitution.json')) {
      throw new Error('knowledge capture rejects a cross-project artifact reference');
    }
    const stat = lstatSync(checked);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('knowledge capture source must be a regular unshared file');
    if (stat.size > MAX_KNOWLEDGE_HANDOFF_BYTES) throw new Error('knowledge capture source exceeds 1 MiB');
    const bytes = readFileSync(checked);
    if (bytes.length > MAX_KNOWLEDGE_HANDOFF_BYTES) throw new Error('knowledge capture source exceeds 1 MiB');
    const body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (body.includes('\0')) throw new Error('knowledge capture does not support binary evidence');
    const sha = digest(bytes);
    const previous = reads.get(checked);
    if (previous && previous !== sha) throw new Error('knowledge capture source changed during capture');
    reads.set(checked, sha);
    return body;
  }
  function source(file, role, projectedBody = null) {
    const raw = read(file);
    const body = projectedBody === null ? raw : jsonText(projectedBody);
    const ref = relative(projectRoot, file);
    if (!ref) throw new Error('knowledge capture source ref must not be empty');
    if (sources.has(ref)) return sources.get(ref);
    const mediaType = projectedBody !== null || file.endsWith('.json') ? 'application/json'
      : file.endsWith('.md') ? 'text/markdown' : 'text/plain';
    if (mediaType === 'application/json') {
      try { JSON.parse(body); } catch { throw new Error('knowledge capture source contains invalid JSON; contents omitted'); }
    }
    const item = { ref, role, mediaType, body, sourceDigest: digest(body) };
    totalBytes += Buffer.byteLength(body);
    if (totalBytes > MAX_KNOWLEDGE_HANDOFF_BYTES) throw new Error('knowledge capture exceeds 1 MiB');
    sources.set(ref, item);
    return item;
  }
  return {
    read, source,
    json(file) {
      const body = read(file);
      try { return JSON.parse(body); } catch { throw new Error('knowledge capture source contains invalid JSON; contents omitted'); }
    },
    sources: () => [...sources.values()].sort((a, b) => a.ref.localeCompare(b.ref)),
    unchanged() {
      for (const [file, expected] of reads) {
        if (digest(read(file)) !== expected) throw new Error('knowledge capture source changed during capture');
      }
    },
  };
}

function approvalProvenance(reader, artifactRoot, iterationId, taskId, completedAt) {
  const ledgerPath = path.join(artifactRoot, 'decisions.jsonl');
  if (!existsSync(ledgerPath)) return;
  reader.read(ledgerPath);
  const records = validateDecisionLedger(ledgerPath);
  const selected = records.filter((record) => Date.parse(record.at) <= Date.parse(completedAt)
    && (record.type.startsWith('constitution.') || record.type.startsWith('gate.how.')
      || (!taskId && record.scope_ref?.startsWith(`iterations/${iterationId}/`))));
  // This is historical provenance, never a replayable or truncated native ledger.
  reader.source(ledgerPath, 'decision', {
    schema_version: 'p2a.decision_provenance_snapshot.v1',
    authority: 'historical_only', recordsDigest: digest(jsonText(selected)), records: selected,
  });
}

function captureReferenceBundle(reader, artifactRoot, intakePath, specPath) {
  // The established spec validator checks approved sidecar bindings and every
  // captured reference hash. Preserve that closed dependency set as well.
  validateSpec(specPath, intakePath, { artifactRoot });
  const snapshotPath = path.join(path.dirname(intakePath), 'reference-bundle-snapshot.json');
  const usagePath = path.join(path.dirname(specPath), 'reference-bundle-usage.json');
  if (!existsSync(snapshotPath)) return;
  const snapshot = reader.json(snapshotPath);
  reader.source(snapshotPath, 'decision');
  reader.source(usagePath, 'decision');
  const referenceRoot = path.dirname(snapshotPath);
  const refs = [snapshot.source_bundle_ref, snapshot.entry_ref,
    ...snapshot.references.map((reference) => reference.path)];
  for (const ref of new Set(refs)) {
    const file = artifactRef(referenceRoot, ref);
    reader.source(file, 'evidence');
  }
}

function captureRuns(reader, artifactRoot, projectRoot, projectId, iterationId, taskId, graphPath) {
  const runsDir = path.join(artifactRoot, 'runs');
  if (existsSync(runWriteTransactionPath(runsDir))) throw new Error('knowledge capture requires no pending run write');
  const indexPath = path.join(runsDir, 'run-index.json');
  const index = reader.json(indexPath);
  validateRunIndexData(index);
  if (index.projectId !== projectId) throw new Error('knowledge capture run index project does not match');
  const entries = index.runs.filter((entry) => entry.iterationId === iterationId && (!taskId || entry.taskId === taskId));
  if (!entries.length) throw new Error('knowledge capture requires preserved execution evidence');
  const runs = [];
  for (const entry of entries) {
    const runPath = artifactRef(runsDir, entry.runRef);
    const run = reader.json(runPath);
    validateRunData(run);
    for (const field of ['runId', 'taskId', 'iterationId', 'status', 'agentTool', 'workspaceRef', 'taskGraphRef', 'startedAt', 'finishedAt']) {
      if (JSON.stringify(run[field]) !== JSON.stringify(entry[field])) throw new Error(`knowledge capture run index mismatch: ${field}`);
    }
    if ((entry.runKind ?? null) !== (run.runKind ?? null) || run.projectId !== projectId
      || run.sourceLayout !== (taskId ? 'maintenance' : 'iteration')
      || path.resolve(artifactRef(artifactRoot, run.taskGraphRef)) !== graphPath) {
      throw new Error('knowledge capture run identity does not match selected work');
    }
    if (run.status === 'started') throw new Error('knowledge capture cannot include active runs');
    if (!Number.isFinite(Date.parse(run.finishedAt))) throw new Error('knowledge capture requires recorded run completion timestamps');
    if (run.visualReview || run.visualReviewEvidenceSha256) {
      throw new Error('knowledge capture does not yet support required visual/binary evidence; originals retained');
    }
    const expectedSpec = taskId ? path.join(artifactRoot, 'current-spec.json')
      : path.join(artifactRoot, 'iterations', iterationId, 'gate-b-spec', 'spec.json');
    // Native runs store the graph-relative sourceSpec (including its canonical ../).
    if (typeof run.sourceSpecRef !== 'string'
      || path.resolve(path.dirname(graphPath), run.sourceSpecRef) !== expectedSpec) {
      throw new Error('knowledge capture source spec does not match selected work');
    }
    reader.read(expectedSpec);
    if (run.currentDevelopmentContractRef) reader.source(artifactRef(artifactRoot, run.currentDevelopmentContractRef), 'contract');
    if (run.executionEnvelopeRef) {
      reader.source(artifactRef(runsDir, executionEnvelopeStoreRef(run, run.executionEnvelopeRef.sha256)), 'contract');
    }
    for (const source of run.executionEnvelope?.sourceGateRefs ?? []) {
      const item = reader.source(artifactRef(artifactRoot, source.path), 'contract');
      const expected = source.path === 'current-development-contract.json'
        ? `sha256:${currentDevelopmentContractSha256(JSON.parse(item.body))}` : item.sourceDigest;
      if (expected !== `sha256:${source.sha256}`) throw new Error('knowledge capture source gate binding changed');
    }
    const sidecars = new Map();
    for (const suffix of RUN_SIDECAR_SUFFIXES) {
      const file = runPath.replace(/\.json$/, suffix);
      safePath(projectRoot, file, { missing: true });
      if (existsSync(file)) sidecars.set(suffix, reader.source(file, 'evidence'));
    }
    if (run.monitorGate?.required) {
      const gateSource = sidecars.get('.monitor-gate.json');
      if (!gateSource) throw new Error('knowledge capture required monitor gate is missing');
      const gate = normalizeMonitorGateSidecar(JSON.parse(gateSource.body), run.runId, entry.runRef);
      assertRunMonitorGateBinding(run, gate);
      if (run.status === 'finished' || run.monitorVerdictEvidenceSha256 || run.failure?.source === 'monitor') {
        const verdictSource = sidecars.get('.monitor-verdict.json');
        if (!verdictSource) throw new Error('knowledge capture required monitor verdict is missing');
        assertRunMonitorVerdictBinding(run, verdictSource.body);
        const verdict = normalizeMonitorVerdictData(JSON.parse(verdictSource.body), {
          requiredConcernFields: gate.requiredConcernFields,
          requiredRuleIds: gate.ruleContract?.ruleIds,
          requireRulesReviewed: gate.ruleContract !== null,
        });
        if (run.status === 'finished' && (!gate.acceptedVerdicts.includes(verdict.verdict) || verdict.hasConcerns)) {
          throw new Error('knowledge capture finished run lacks accepted monitor evidence');
        }
      }
      if (gate.ruleContract?.ref) {
        const file = gate.ruleContract.ref === '.plan2agent/constitution.json'
          ? path.join(projectRoot, gate.ruleContract.ref) : artifactRef(artifactRoot, gate.ruleContract.ref);
        const source = reader.source(file, 'contract');
        if (source.sourceDigest !== `sha256:${gate.ruleContract.sha256}`) throw new Error('knowledge capture monitor rule binding changed');
      }
    }
    if (run.status === 'finished') {
      validateRunTaskContract(run, artifactRoot, { runsDir });
      if (run.acceptanceReview?.required) {
        if (!sidecars.has('.acceptance-review.json')) throw new Error('knowledge capture required acceptance evidence is missing');
        readRequiredAcceptanceReviewEvidence(runsDir, run, { index });
      }
    }
    reader.source(runPath, 'verification');
    runs.push(run);
  }
  for (const run of runs) {
    if (run.reviewRemediation && !runs.some((candidate) => candidate.runId === run.reviewRemediation.sourceRunId)) {
      throw new Error('knowledge capture remediation source run is missing');
    }
  }
  reader.source(indexPath, 'verification', {
    schema_version: 'p2a.run_index_snapshot.v1', projectId,
    selection: { iterationId, taskId: taskId ?? null }, runs: entries,
  });
  const latest = [...runs].reverse().sort((a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt))[0];
  if (taskId && (latest.status !== 'finished' || latest.runKind)) throw new Error('knowledge capture maintenance requires a finished latest task run');
  return { runs, latest };
}

function capturedRepository(projectId, runs) {
  const candidates = runs.filter((run) => run.status === 'finished').flatMap((run) => run.verification)
    .filter((item) => ['command', 'config'].includes(item.source) && item.status === 'passed'
      && item.exitCode === 0 && item.startedAt && item.finishedAt)
    .sort((a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt));
  const evidence = candidates[0];
  return {
    id: projectId,
    codeRevision: evidence?.gitHeadSha ?? null,
    contentDigest: evidence?.productRevisionSha256 ? `sha256:${evidence.productRevisionSha256}` : null,
  };
}

function captureLocked(options, projectRoot, artifactRoot) {
  const reader = createReader(projectRoot, artifactRoot);
  const pointerPath = path.join(artifactRoot, 'current-spec.json');
  const pointer = reader.json(pointerPath);
  const projectId = pointer.project_id;
  if (pointer.schema_version !== 'p2a.current_spec.v1' || !safeId(projectId)) throw new Error('knowledge capture requires a valid project identity');
  const canonicalArtifacts = path.join(projectRoot, '.plan2agent', 'artifacts');
  if (inside(canonicalArtifacts, artifactRoot) && path.basename(artifactRoot) !== projectId) throw new Error('knowledge capture artifact project does not match');
  const taskId = options.task;
  const iterationId = taskId ? 'maintenance' : options.iteration;
  const graphPath = path.join(artifactRoot, 'iterations', iterationId, 'gate-c-task-graph', 'task-graph.json');
  const graph = reader.json(graphPath);
  validateTaskGraphData(graph);
  if (graph.projectId !== projectId) throw new Error('knowledge capture task graph project does not match');
  const expectedSpec = taskId ? pointerPath : path.join(artifactRoot, 'iterations', iterationId, 'gate-b-spec', 'spec.json');
  if (path.resolve(path.dirname(graphPath), graph.sourceSpec) !== expectedSpec) throw new Error('knowledge capture graph source does not match selected work');
  reader.read(expectedSpec);
  let baseline;
  let summary;
  let completedAt;
  let areas;
  if (taskId) {
    const task = graph.tasks.find((item) => item.id === taskId);
    if (!task || task.status !== 'done') throw new Error('knowledge capture requires a done maintenance task');
    const body = jsonText({
      schema_version: 'p2a.maintenance_completion.v1', projectId, taskId,
      taskContract: immutableTaskContract(task), taskContractSha256: taskContractSha256(task),
      intent: task.intent ?? null,
    });
    baseline = { format: 'p2a.maintenance_completion.v1', body, sourceDigest: digest(body) };
    reader.source(graphPath, 'task', JSON.parse(body));
    reader.source(pointerPath, 'decision', {
      schema_version: 'p2a.maintenance_source_snapshot.v1', projectId,
      authority: 'project_identity_only', taskId,
    });
    summary = task.intent ?? task.title;
    areas = task.targetArea;
  } else {
    if (pointer.active_iteration !== iterationId) throw new Error('knowledge capture requires the current matching completed iteration; capture before opening next work');
    if (!pointer.closed_iterations?.some((record) => record.iteration_id === iterationId && record.status === 'archived')) {
      throw new Error('knowledge capture requires a closed iteration');
    }
    const contractPath = path.join(artifactRoot, 'current-development-contract.json');
    const contract = reader.json(contractPath);
    if (contract.visualContract) throw new Error('knowledge capture does not yet support required visual/binary evidence; originals retained');
    reader.source(expectedSpec, 'contract');
    reader.source(graphPath, 'task');
    reader.source(path.join(artifactRoot, 'iterations', iterationId, 'iteration.json'), 'decision');
    if (existsSync(path.join(artifactRoot, 'status.md'))) reader.read(path.join(artifactRoot, 'status.md'));
    if (contract.bindings?.constitution?.ref) reader.source(path.join(projectRoot, '.plan2agent', 'constitution.json'), 'contract');
    const intakePath = path.join(artifactRoot, 'iterations', iterationId, 'gate-a-intake', 'intake.json');
    if (existsSync(intakePath)) reader.source(intakePath, 'decision');
    captureReferenceBundle(reader, artifactRoot, intakePath, expectedSpec);
    const state = resolveCurrentDevelopmentState(artifactRoot);
    const archived = validateActiveIterationArchiveConsistency(state);
    if (!archived.archived || graph.tasks.some((task) => task.status !== 'done')) throw new Error('knowledge capture requires a closed iteration with all tasks done');
    const record = archived.closedRecord;
    if (JSON.stringify(archived.metadata.close) !== JSON.stringify(record)) throw new Error('knowledge capture close metadata does not match its archive record');
    for (const [ref, audit] of Object.entries(record.artifact_hashes ?? {})) {
      const file = artifactRef(artifactRoot, ref);
      safePath(projectRoot, file, { missing: true });
      if (typeof audit === 'string' || audit?.present === true) reader.source(file, 'evidence');
    }
    auditArchivedIterationArtifacts({ closed_iterations: [record] }, artifactRoot);
    reader.source(pointerPath, 'decision', { schema_version: 'p2a.iteration_close_snapshot.v1', projectId, close: record });
    const source = reader.source(contractPath, 'contract');
    baseline = { format: contract.schema_version, body: source.body, sourceDigest: source.sourceDigest };
    summary = contract.objective;
    completedAt = record.closed_at;
    areas = graph.tasks.flatMap((task) => task.targetArea);
  }
  const { runs, latest } = captureRuns(reader, artifactRoot, projectRoot, projectId, iterationId, taskId, graphPath);
  completedAt ??= latest.finishedAt;
  if (!completedAt || !Number.isFinite(Date.parse(completedAt))) throw new Error('knowledge capture requires a recorded completion timestamp');
  let completionEvidence = latest;
  if (!taskId) {
    if (runs.some((run) => Date.parse(run.finishedAt) > Date.parse(completedAt))) throw new Error('knowledge capture run evidence changed after iteration close');
    // Reuse the established closure verification profile. Documentation and
    // isolated-code work may legitimately reuse implementation-run evidence.
    completionEvidence = assertFinalFullVerificationReady({
      runsDir: path.join(artifactRoot, 'runs'), runs, artifactRoot, graphPath, activeIteration: iterationId,
    }).run;
    const contractHash = currentDevelopmentContractSha256(JSON.parse(baseline.body));
    if (completionEvidence.currentDevelopmentContractSha256 !== contractHash) {
      throw new Error('knowledge capture final evidence is not bound to the completed development contract');
    }
  }
  approvalProvenance(reader, artifactRoot, iterationId, taskId, completedAt);
  const bundle = {
    schemaVersion: 'buildlore.completion-input.v1', projectId,
    workId: taskId ?? iterationId, workKind: taskId ? 'maintenance' : 'iteration', completedAt,
    repository: capturedRepository(projectId, [completionEvidence]), predecessor: null,
    affectedAreas: [...new Set(Array.isArray(areas) ? areas : [areas])].filter(Boolean).sort(), supersedes: [],
    baseline,
    knowledge: { summary: options.summary ?? summary, decisions: [], lessons: [], remaining: [] },
    sources: reader.sources(),
  };
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
  validateSchema(bundle, schema);
  validateTextBounds(bundle, schema);
  const body = jsonText(bundle);
  if (Buffer.byteLength(body) > MAX_KNOWLEDGE_HANDOFF_BYTES) throw new Error('knowledge capture exceeds 1 MiB');
  reader.unchanged();
  const inputDigest = digest(body);
  const file = path.join(artifactRoot, 'handoffs', 'pending', `${inputDigest.slice(7)}.json`);
  safePath(projectRoot, file, { missing: true });
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // Raw snapshots must not enter a product commit through ordinary git add .
  publishPrivateFile(projectRoot, path.join(path.dirname(file), '.gitignore'), '*\n');
  const existed = publishPrivateFile(projectRoot, file, body);
  return {
    schemaVersion: 'p2a.knowledge-capture-receipt.v1', projectId, workId: bundle.workId,
    workKind: bundle.workKind, inputDigest, bundlePath: relative(projectRoot, file),
    storage: 'pending', sanitized: false, durable: false, wikiApproved: false,
    cleanupEligible: false, reused: existed,
  };
}

export function captureKnowledge(options) {
  if (!options?.artifacts || Boolean(options.iteration) === Boolean(options.task)) throw new Error('knowledge capture requires --artifacts and exactly one of --iteration or --task');
  if (options.iteration && (!safeId(options.iteration) || options.iteration === 'maintenance')) throw new Error('knowledge capture iteration id is invalid');
  if (options.task && !/^task-[0-9]+$/.test(options.task)) throw new Error('knowledge capture maintenance task id is invalid');
  if (options.summary !== undefined && (typeof options.summary !== 'string' || !options.summary.trim())) throw new Error('knowledge capture summary must not be blank');
  if (options.summary !== undefined && options.summary.length > 65536) throw new Error('knowledge capture text exceeds 65536 characters');
  const artifactRoot = path.resolve(options.artifacts);
  const inferredProjectRoot = canonicalWorkspacePathForArtifactRoot(artifactRoot);
  const projectRoot = path.resolve(options.target ?? inferredProjectRoot);
  safePath(projectRoot, artifactRoot);
  if (path.basename(path.dirname(artifactRoot)) === 'artifacts'
    && path.basename(path.dirname(path.dirname(artifactRoot))) === '.plan2agent'
    && projectRoot !== inferredProjectRoot) throw new Error('knowledge capture target does not match its canonical project');
  if (!lstatSync(artifactRoot).isDirectory()) throw new Error('knowledge capture artifact root must be a directory');
  const locks = [artifactRoot, path.join(artifactRoot, 'iterations'), path.join(artifactRoot, 'runs'),
    path.join(artifactRoot, 'iterations', options.task ? 'maintenance' : options.iteration, 'gate-c-task-graph')];
  for (const lock of locks) safePath(projectRoot, lock, { missing: true });
  return withRunStoreLocks(locks, () => captureLocked(options, projectRoot, artifactRoot));
}

export function main(argv = process.argv.slice(2)) {
  const usage = 'Usage: p2a knowledge capture --artifacts <root> [--target <project-root>] (--iteration <id>|--task <maintenance-id>) [--summary <text>] [--json]';
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) { console.log(usage); return 0; }
  try {
    if (argv[0] !== 'capture') throw new Error('knowledge supports only capture');
    const options = {};
    for (let index = 1; index < argv.length; index += 1) {
      const flag = argv[index];
      if (flag === '--json') { options.json = true; continue; }
      if (!['--artifacts', '--target', '--iteration', '--task', '--summary'].includes(flag)) throw new Error(`unknown option: ${flag}`);
      const value = argv[++index];
      if (!value || value.startsWith('--') || options[flag.slice(2)] !== undefined) throw new Error(`invalid or duplicate ${flag}`);
      options[flag.slice(2)] = value;
    }
    const receipt = captureKnowledge(options);
    console.log(options.json ? JSON.stringify(receipt) : `Captured pending knowledge bundle: ${receipt.bundlePath}\nLocal, unsanitized snapshot only. Originals retained; cleanup is not enabled.`);
    return 0;
  } catch (error) {
    console.error(`p2a knowledge: ${error instanceof SyntaxError || /invalid JSON|JSON.*position|Unexpected token/.test(error.message)
      ? 'invalid JSON in selected capture input; contents omitted' : error.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main();
