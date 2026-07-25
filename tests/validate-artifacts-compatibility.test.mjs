import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  normalizeOrchestrationPlanData,
  normalizeOrchestrationRuntimeData,
} from '../scripts/validate_artifacts.mjs';

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
