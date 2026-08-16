/** Canonical runtime-continuation contract shared by next-state and packet commands. */

export const RUNTIME_PACKET_MODES = Object.freeze(['direct', 'planned']);

export const CONTINUATION_DEFINITIONS = Object.freeze({
  'execution.prepare': Object.freeze({
    activation: 'immediate',
    phase: 'prepare',
    binding: null,
  }),
  'execution.owner-start': Object.freeze({
    activation: 'after_command_success',
    phase: 'owner-start',
    binding: Object.freeze({
      kind: 'command_result',
      schema_version: 'p2a.execution_result.v1',
      field: 'runId',
    }),
  }),
  'execution.visual-review': Object.freeze({
    activation: 'after_command_success',
    phase: 'visual-review',
    binding: Object.freeze({
      kind: 'command_result',
      schema_version: 'p2a.execution_result.v1',
      field: 'runId',
    }),
  }),
  'execution.acceptance-review': Object.freeze({
    activation: 'after_command_success',
    phase: 'acceptance-review',
    binding: Object.freeze({
      kind: 'command_result',
      schema_version: 'p2a.execution_result.v1',
      field: 'runId',
    }),
  }),
});

export function supportsRuntimePacketMode(mode) {
  return RUNTIME_PACKET_MODES.includes(mode);
}

export function continuationDescriptor(id, mode = null) {
  const definition = CONTINUATION_DEFINITIONS[id];
  if (!definition) throw new Error(`unknown execution continuation: ${id}`);
  return {
    id,
    activation: definition.activation,
    skill: 'p2a-dev-execution',
    phase: definition.phase,
    mode,
    ...(definition.binding ? { binding: { ...definition.binding } } : {}),
  };
}

export function runtimePacketModeForContext(context) {
  const mode = context?.startedRun?.mode
    ?? context?.gates?.taskGraph?.execution?.mode
    ?? context?.executionModePolicy
    ?? null;
  return supportsRuntimePacketMode(mode) ? mode : null;
}
