/** Shared Plan2Agent constants used by multiple runtime scripts. */

import path from 'node:path';

export const GATE_FILES = [
  ['gate_a_intake', 'Gate A intake', path.join('gate-a-intake', 'intake.json')],
  ['gate_b_spec', 'Gate B spec', path.join('gate-b-spec', 'spec.json')],
  ['gate_c_task_graph', 'Gate C task graph', path.join('gate-c-task-graph', 'task-graph.json')],
];

export const GREENFIELD_REQUIRED_FILES = [
  'status.md',
  ...GATE_FILES.map(([, , relativePath]) => relativePath),
];

export const P2A_DIR = '.plan2agent';
export const DEFAULT_RUNS_DIR = `${P2A_DIR}/runs`;
export const RUN_TELEMETRY_PROTOCOL = 'p2a.run_telemetry.manual.v1';

export const REFERENCE_BUNDLE_SNAPSHOT_FILENAME = 'reference-bundle-snapshot.json';
export const REFERENCE_BUNDLE_USAGE_FILENAME = 'reference-bundle-usage.json';
export const REFERENCE_BUNDLE_SOURCE_DIRNAME = 'reference-sources';
export const REFERENCE_BUNDLE_SOURCE_FILES_DIRNAME = 'files';
export const APPROVAL_SIDECAR_SHA256_PREFIX = 'Sidecar SHA-256:';

export const ISOLATION_MODES = new Set(['none', 'branch', 'worktree']);

export const FAILURE_CLASSES = new Set(['verification_failed', 'test_flake', 'scope_violation', 'missing_dependency', 'environment_failure', 'implementation_incomplete', 'other']);

export const FAILURE_RETRYABLE = new Set(['yes', 'no', 'after_fix']);
