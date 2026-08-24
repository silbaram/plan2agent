import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  normalizeOrchestrationPlanData,
  normalizeOrchestrationRuntimeData,
  validateTaskContextData,
} from '../scripts/validate_artifacts.mjs';

function taskContext(schemaVersion) {
  return {
    schema_version: schemaVersion,
    project_id: 'context-contract',
    active_iteration: 'iter-001',
    scope: 'feature',
    idea: null,
    baseline_effective_spec_ref: null,
    effective_spec: { product: {}, implementation: {} },
    existing_tasks: { active: [], maintenance: [] },
    spec_field_changes: [],
    code_signals: {
      code_root: null,
      file_tree: [],
      truncated: false,
      recent_changes: [],
    },
  };
}

test('task context v2 identifies the reduced post-retirement contract', () => {
  assert.doesNotThrow(() => validateTaskContextData(taskContext('p2a.task_context.v2')));
  assert.throws(
    () => validateTaskContextData(taskContext('p2a.task_context.v1')),
    /schema_version must equal "p2a\.task_context\.v2"/,
  );
});

test('legacy orchestration normalization exports remain compatible for scaffold consumers', () => {
  const role = {
    agentTool: 'codex',
    role: 'contributor',
    profile: 'fullstack_implementer',
  };
  const plan = { roles: [role] };
  const runtime = {
    sharedMentalModel: {
      roleAssignments: [role],
    },
  };

  const normalizedPlan = normalizeOrchestrationPlanData(plan);
  const normalizedRuntime = normalizeOrchestrationRuntimeData(runtime);

  assert.equal(plan.roles[0].executionGuide, undefined);
  assert.equal(runtime.sharedMentalModel.roleAssignments[0].executionGuide, undefined);
  assert.equal(
    normalizedPlan.roles[0].executionGuide.recommendedFeature,
    'skills_custom_agents_explicit_subagent_prompt',
  );
  assert.equal(
    normalizedRuntime.sharedMentalModel.roleAssignments[0].executionGuide.startsProcess,
    false,
  );
});
