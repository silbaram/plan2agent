/** Extract attributed knowledge from the selected, already validated capture sources. */
import { executedCheck } from './p2a_development_brief.mjs';
import { compareRunEvidence } from './p2a_run_paths.mjs';
import { verificationAttemptKey, verificationCommandIdentity } from './p2a_verification_evidence.mjs';

const text = (value) => typeof value === 'string' ? value.trim() : '';
const list = (value) => Array.isArray(value) ? value : [];
const citation = (source, pointer) => `[source: ${source.ref}#${pointer}; ${source.sourceDigest}]`;
const runGroupKey = (run) => `${run.taskId}:${run.runKind ?? 'implementation'}`;

export function extractCompletionKnowledge({ summary, sources, specRef = null, intakeRef = null }) {
  const knowledge = { summary, decisions: [], lessons: [], remaining: [] };
  const sourceByRef = new Map(sources.map((source) => [source.ref, source]));
  const add = (category, value, source, pointer) => {
    if (text(value)) knowledge[category].push(`${value} ${citation(source, pointer)}`);
  };
  const specSource = sourceByRef.get(specRef);
  const spec = specSource ? JSON.parse(specSource.body) : null;
  const intakeSource = sourceByRef.get(intakeRef);
  const intake = intakeSource ? JSON.parse(intakeSource.body) : null;

  if (intake?.status === 'ready_for_spec' && intake.approval_audit) {
    list(intake.needs_user_decision).forEach((decision, index) => {
      if (decision.status !== 'answered') return;
      const superseded = text(decision.disposition).startsWith('superseded_by_');
      const answer = text(superseded ? decision.current_resolution : decision.answer);
      if (!answer) return;
      // Impact explains why a question mattered; it is not evidence for why an
      // option was chosen. Preserve the answer without inventing that rationale.
      add('decisions', `Approved answer${superseded ? ' (updated)' : ''}: ${decision.question} — ${answer}. Selection rationale is not recorded in this answer.`,
        intakeSource, `/needs_user_decision/${index}`);
    });
  }
  if (spec?.approval === 'approved') {
    list(spec.clarifying_question_disposition).forEach((decision, index) => {
      const pointer = `/clarifying_question_disposition/${index}`;
      if (decision.status === 'assumed') {
        add('remaining', `Assumption, not a verified fact: ${decision.assumption ?? decision.rationale}. Recorded rationale: ${decision.rationale}`,
          specSource, pointer);
      } else if (decision.status === 'deferred_non_goal') {
        add('remaining', `Deferred outside this scope (not scheduled): ${decision.non_goal ?? decision.rationale}. Recorded rationale: ${decision.rationale}`,
          specSource, pointer);
      } else {
        const resolution = text(decision.resolution) || text(decision.resolved_by);
        if (resolution) add('decisions', `Approved resolution: ${resolution}. Recorded rationale: ${decision.rationale}`, specSource, pointer);
      }
    });
    list(spec.reference_reconnaissance?.candidates).forEach((candidate, index) => {
      const pointer = `/reference_reconnaissance/candidates/${index}`;
      if (['selected', 'rejected'].includes(candidate.decision)) {
        add('decisions', `${candidate.decision === 'selected' ? 'Selected' : 'Rejected'} alternative: ${candidate.title}. Recorded rationale: ${candidate.rationale}`,
          specSource, pointer);
      } else if (['deferred', 'open'].includes(candidate.decision)) {
        add('remaining', `${candidate.decision === 'deferred' ? 'Deferred' : 'Open'} alternative (not selected or scheduled): ${candidate.title}. Recorded rationale: ${candidate.rationale}`,
          specSource, pointer);
      }
    });
  }

  const verificationSources = sources
    .filter((source) => source.role === 'verification' && source.mediaType === 'application/json')
    .map((source) => ({ source, document: JSON.parse(source.body) }));
  const indexedRuns = new Map();
  for (const { document } of verificationSources) {
    if (document.schema_version !== 'p2a.run_index_snapshot.v1') continue;
    for (const [runOrder, indexEntry] of list(document.runs).entries()) {
      indexedRuns.set(indexEntry.runId, { runOrder, indexEntry });
    }
  }
  const runSources = verificationSources
    .filter(({ document }) => ['p2a.run.v1', 'p2a.run.v2'].includes(document.schema_version))
    .map(({ source, document: run }, sourceOrder) => ({
      source, run, ...(indexedRuns.get(run.runId) ?? { runOrder: sourceOrder }),
    }))
    // Replay oldest first, using the lifecycle's persisted order for tied times.
    .sort((a, b) => compareRunEvidence(b, a));
  const runById = new Map(runSources.map((entry) => [entry.run.runId, entry]));
  const latestByTask = new Map();
  for (const entry of runSources) latestByTask.set(runGroupKey(entry.run), entry);
  const incidentGroups = new Set();

  for (const entry of runSources) {
    const { source, run } = entry;
    const groupKey = runGroupKey(run);
    // Explicitly labelled notes are owner reports, not independently established
    // facts. Untagged prose and raw stdout are never mined for causal claims.
    list(run.notes).forEach((note, index) => {
      const match = /^(decision|lesson|remaining):\s*(\S[\s\S]*)$/iu.exec(note);
      if (!match) return;
      const kind = match[1].toLowerCase();
      if (kind === 'remaining' && latestByTask.get(groupKey) !== entry) return;
      const category = { decision: 'decisions', lesson: 'lessons', remaining: 'remaining' }[kind];
      add(category, `Owner-reported ${kind}: ${match[2].trim()}`, source, `/notes/${index}`);
    });

    const incidents = [];
    const reviewSource = runById.get(run.reviewRemediation?.sourceRunId);
    if (reviewSource) {
      incidents.push(`Recorded review finding: ${run.reviewRemediation.finding} ${citation(source, '/reviewRemediation')}`);
    }
    for (const [field, property, label] of [
      ['reproduction', 'steps', 'Recorded reproduction'],
      ['localization', 'findings', 'Recorded diagnosis (not independently confirmed)'],
      ['fixSummary', 'summaries', 'Recorded correction'],
      ['guard', 'checks', 'Recorded recurrence guard'],
    ]) {
      list(run[field]?.[property]).forEach((value, index) => {
        incidents.push(`${label}: ${value} ${citation(source, `/${field}/${property}/${index}`)}`);
      });
    }
    const failures = list(run.verification).filter((check) => executedCheck(check) && check.status === 'failed');
    if (run.failure || failures.length || reviewSource) incidentGroups.add(groupKey);
    if (incidentGroups.has(groupKey) && incidents.length) knowledge.lessons.push(incidents.join('\n'));

    const byCheck = new Map();
    list(run.verification).forEach((check, index) => {
      if (!executedCheck(check)) return;
      const key = verificationAttemptKey(check);
      const history = byCheck.get(key) ?? [];
      history.push({ check, index });
      byCheck.set(key, history);
    });
    for (const history of byCheck.values()) {
      const failure = history.find(({ check }) => check.status === 'failed');
      const latest = history.at(-1);
      if (!failure || latest.check.status !== 'passed' || latest.index <= failure.index) continue;
      knowledge.lessons.push(`Observed retry: ${verificationCommandIdentity(latest.check)} failed and later passed at their recorded revisions. This sequence alone does not establish a cause or a fix. ${citation(source, `/verification/${failure.index}`)} ${citation(source, `/verification/${latest.index}`)}`);
    }
  }
  for (const category of ['decisions', 'lessons', 'remaining']) {
    knowledge[category] = [...new Set(knowledge[category])];
  }
  return knowledge;
}
