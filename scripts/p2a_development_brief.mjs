/** Read-only progress evidence. A briefing never changes readiness or grants authority. */
import {
  workspaceRevisionExcludedPathsForRun,
  workspaceRevisionSha256,
} from './p2a_run_paths.mjs';
import { verificationAttemptKey, verificationCommandIdentity } from './p2a_verification_evidence.mjs';

const strings = (values) => (Array.isArray(values) ? values : [])
  .filter((value) => typeof value === 'string' && value.trim());

export function executedCheck(item) {
  return ['command', 'config'].includes(item?.source)
    && ['passed', 'failed'].includes(item.status)
    // A timed-out command has no exit code. Spawn failures are recorded as
    // unavailable by the runner and remain excluded by the status check above.
    && (item.status === 'passed'
      ? item.exitCode === 0
      : item.exitCode === null || (Number.isInteger(item.exitCode) && item.exitCode !== 0))
    && Number.isFinite(Date.parse(item.startedAt))
    && Number.isFinite(Date.parse(item.finishedAt))
    && Date.parse(item.finishedAt) >= Date.parse(item.startedAt);
}

export function buildDevelopmentBrief({ run, task, sourceRef, workspaceRevision = null, requiresUserDecision = false }) {
  const attempts = Array.isArray(run.verification) ? run.verification : [];
  // Select the latest attempt before testing its revision. An earlier pass must
  // never hide a later failure, unavailable command, or explicitly skipped check.
  const latest = new Map();
  attempts.forEach((item, index) => latest.set(verificationAttemptKey(item), { item, index }));
  const checks = [...latest.values()].map(({ item, index }) => ({
    type: item.type,
    command: verificationCommandIdentity(item),
    status: item.status,
    scope: item.scope ?? 'full',
    milestoneId: item.milestoneId ?? null,
    executed: executedCheck(item),
    freshness: workspaceRevision && item.workspaceRevisionSha256
      ? (item.workspaceRevisionSha256 === workspaceRevision ? 'current' : 'historical')
      : 'unknown',
    evidenceRef: `${sourceRef}#/verification/${index}`,
  }));
  const passed = (check) => check.executed && check.freshness === 'current' && check.status === 'passed';
  const verifiedOutcomes = [];
  const remaining = [];
  for (const [index, milestone] of (run.milestones ?? []).entries()) {
    const evidence = checks.filter((check) => check.milestoneId === milestone.id);
    const verified = milestone.status === 'verified'
      && milestone.verification.length > 0
      && milestone.verification.every((command) => evidence.some((check) => check.command === command && passed(check)))
      && evidence.every(passed);
    const outcome = { text: milestone.outcome, evidenceRef: `${sourceRef}#/milestones/${index}` };
    if (verified) verifiedOutcomes.push(outcome);
    // Later planned work normally changes the workspace. Historical checkpoint
    // evidence is not a current pass, but it does not reopen a completed stage.
    else if (milestone.status === 'pending') remaining.push(outcome);
  }
  const reportedChanges = (Array.isArray(run.fixSummary?.summaries) ? run.fixSummary.summaries : [])
    .map((text, index) => ({ text, evidenceRef: `${sourceRef}#/fixSummary/summaries/${index}` }))
    .filter(({ text }) => typeof text === 'string' && text.trim());
  for (const [index, note] of (run.notes ?? []).entries()) {
    const match = /^remaining:\s*(\S[\s\S]*)$/iu.exec(note);
    if (match) remaining.push({ text: match[1].trim(), evidenceRef: `${sourceRef}#/notes/${index}` });
  }
  return {
    runId: run.runId,
    goal: task?.intent ?? run.executionEnvelope?.objective ?? task?.title ?? run.taskTitle,
    sourceRef,
    reportedChanges,
    verifiedOutcomes,
    checks,
    remaining,
    completionCriteria: strings(task?.acceptanceCriteria),
    requiresUserDecision,
  };
}

export function inspectDevelopmentBrief({ run, task, sourceRef, runsDir, artifactRoot, graphPath, requiresUserDecision }) {
  let workspaceRevision = null;
  if ((run.verification ?? []).some((item) => item.workspaceRevisionSha256)) {
    try {
      workspaceRevision = workspaceRevisionSha256(run.workspacePath,
        workspaceRevisionExcludedPathsForRun(runsDir, run, { artifactRoot, graphPath }));
    } catch {
      // Missing worktrees and unreadable files leave evidence unconfirmed. This
      // advisory read must not replace the lifecycle's existing recovery action.
    }
  }
  return buildDevelopmentBrief({ run, task, sourceRef, workspaceRevision, requiresUserDecision });
}

export function renderDevelopmentBrief(brief, language = 'en') {
  if (!brief) return [];
  const ko = language === 'ko';
  const labels = ko
    ? { test: '테스트', lint: '린트', typecheck: '타입 검사', custom: '추가 검사' }
    : { test: 'tests', lint: 'lint', typecheck: 'type checks', custom: 'additional checks' };
  const passed = brief.checks.filter((check) => check.executed && check.freshness === 'current' && check.status === 'passed');
  const failed = brief.checks.filter((check) => check.executed && check.freshness === 'current' && check.status === 'failed');
  const historical = brief.checks.filter((check) => check.freshness === 'historical');
  const unconfirmed = brief.checks.filter((check) => check.freshness === 'unknown' || !check.executed);
  const checkSummary = [...new Set(passed.map((check) => check.type))]
    .map((type) => `${labels[type]} ${passed.filter((check) => check.type === type).length}`)
    .join(', ');
  const lines = [];
  if (brief.reportedChanges.length) lines.push(`${ko ? '기록된 변경' : 'Reported changes'}: ${brief.reportedChanges.slice(0, 2).map((item) => item.text).join(' / ')}`);
  if (brief.verifiedOutcomes.length) lines.push(`${ko ? '검사로 확인한 단계' : 'Outcomes with passing checkpoint checks'}: ${brief.verifiedOutcomes.slice(0, 2).map((item) => item.text).join(' / ')}`);
  lines.push(passed.length
    ? `${ko ? '현재 작업 파일에서 통과한 검사' : 'Checks passed on the current workspace'}: ${checkSummary}.`
    : (ko ? '현재 작업 파일에서 실행·통과가 확인된 검사는 아직 없습니다.' : 'No executed passing check is confirmed for the current workspace yet.'));
  if (failed.length) lines.push(ko ? `현재 작업 파일에서 실패한 검사 ${failed.length}건을 수정하고 다시 확인해야 합니다.` : `${failed.length} check(s) failed on the current workspace; correct and recheck them.`);
  if (historical.length) lines.push(ko ? `이전 작업 파일에서 나온 검사 ${historical.length}건은 과거 기록입니다.` : `${historical.length} check(s) belong to an earlier workspace revision.`);
  if (unconfirmed.length) lines.push(ko ? `검사 ${unconfirmed.length}건은 실행 여부 또는 현재 파일과의 일치를 확인하지 못했습니다.` : `${unconfirmed.length} check(s) have unconfirmed execution or revision binding.`);
  if (brief.remaining.length) lines.push(`${ko ? '남은 확인' : 'Remaining checks or recorded follow-up'}: ${brief.remaining[0].text}`);
  else if (brief.completionCriteria.length) lines.push(`${ko ? '완료 판단 기준' : 'Completion criteria'}: ${brief.completionCriteria[0]}`);
  if (brief.requiresUserDecision) lines.push(ko ? '계속하려면 아래에 안내한 사용자 결정이 필요합니다.' : 'Continuing requires the user decision described below.');
  return lines;
}
