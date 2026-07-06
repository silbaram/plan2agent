/** Shared Plan2Agent constants used by multiple runtime scripts. */

import path from 'node:path';

export const GATE_FILES = [
  ['gate_a_intake', 'Gate A intake', path.join('gate-a-intake', 'intake.json')],
  ['gate_b_spec', 'Gate B spec', path.join('gate-b-spec', 'spec.json')],
  ['gate_c_task_graph', 'Gate C task graph', path.join('gate-c-task-graph', 'task-graph.json')],
  ['gate_d_review', 'Gate D review', path.join('gate-d-review', 'review.json')],
];

export const GREENFIELD_REQUIRED_FILES = [
  'status.md',
  ...GATE_FILES.map(([, , relativePath]) => relativePath),
];

export const ROLE_PROFILE_TO_ROLE = Object.freeze({
  owner_supervisor: 'lead',
  frontend_implementer: 'contributor',
  backend_implementer: 'contributor',
  fullstack_implementer: 'contributor',
  test_implementer: 'contributor',
  docs_implementer: 'contributor',
  qa_reviewer: 'reviewer',
  architecture_reviewer: 'reviewer',
  security_reviewer: 'reviewer',
  manual_monitor: 'monitor',
});

export const DEFAULT_RUNS_DIR = path.join('.plan2agent', 'runs');

export const ISOLATION_MODES = new Set(['none', 'branch', 'worktree']);

export const FAILURE_CLASSES = new Set(['verification_failed', 'test_flake', 'scope_violation', 'missing_dependency', 'environment_failure', 'implementation_incomplete', 'other']);

export const FAILURE_RETRYABLE = new Set(['yes', 'no', 'after_fix']);
