/** Shared canonical spec seed and composition rules. */

export const PRODUCT_FIELDS = [
  'problem',
  'target_users',
  'goals',
  'non_goals',
  'core_flows',
  'screens_or_interfaces',
  'data_model_draft',
  'external_integrations',
  'success_criteria',
  'constraints',
];

export const IMPLEMENTATION_FIELDS = [
  'architecture',
  'interfaces',
  'data_flow',
  'dependencies',
  'edge_cases',
  'verification',
];

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function jsonEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function asStringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

function appendUnique(values, additions) {
  const next = [...asStringArray(values)];
  for (const addition of additions) {
    if (addition && !next.includes(addition)) next.push(addition);
  }
  return next;
}

export function buildInitialCanonicalSections({ iterationId = 'v1-mvp', idea, intake }) {
  const facts = asStringArray(intake.known_facts);
  const assumptions = Array.isArray(intake.assumptions)
    ? intake.assumptions
        .map((assumption) => assumption?.statement)
        .filter((statement) => typeof statement === 'string' && statement.trim().length > 0)
    : [];
  return {
    product: {
      problem: intake.summary || idea,
      target_users: [
        'Primary users and stakeholders described by the Gate A intake.',
      ],
      goals: appendUnique(facts.slice(0, 6), [
        `Deliver the first iteration scope for ${iterationId}: ${idea}`,
      ]),
      non_goals: [
        'Do not expand beyond the approved first-iteration scope without opening a follow-up decision.',
        'Do not treat unresolved clarification questions as final requirements until they are explicitly approved or converted into assumptions.',
      ],
      core_flows: [
        `A target user follows the first-iteration flow implied by the idea: ${idea}`,
        'The system accepts the primary input or trigger described by the intake and returns the expected first-iteration outcome.',
        'Operators or developers can verify the first-iteration behavior through the planned verification surface.',
      ],
      screens_or_interfaces: [
        'Primary user-facing, developer-facing, or service-facing interface required by the first iteration.',
        'Configuration or setup surface needed to run the first iteration safely.',
        'Verification or observability surface needed to confirm first-iteration behavior.',
      ],
      data_model_draft: [
        'Core entities, inputs, outputs, and state required by the first iteration.',
        'Identifiers, timestamps, ownership fields, or status fields needed to support the first-iteration workflow.',
      ],
      external_integrations: [
        'External systems explicitly named by the intake.',
        'No additional external integration unless required by approved assumptions or decisions.',
      ],
      success_criteria: [
        'The first-iteration workflow can be executed end to end from the primary interface.',
        'The implementation satisfies the approved intake facts and explicitly documented assumptions.',
        'Unresolved clarification questions are either answered before approval or tracked as open decisions.',
        'Verification covers the main success path and at least one relevant failure or edge case.',
      ],
      constraints: appendUnique(assumptions, [
        'Keep the first iteration narrowly scoped to the approved intake.',
        'Prefer additive implementation choices that do not block future iterations.',
        'Document any risky assumption before Gate B approval.',
      ]),
    },
    implementation: {
      architecture: [
        'Implement the smallest architecture that can satisfy the first-iteration workflow and verification criteria.',
        'Separate core domain behavior from integration, configuration, and verification concerns where the target project structure supports it.',
      ],
      interfaces: [
        'Define the primary interface contract needed by the first iteration.',
        'Define any setup, configuration, or operational contract needed to run and verify the first iteration.',
      ],
      data_flow: [
        'Primary input enters through the selected interface, is validated, and is transformed into the first-iteration output or state change.',
        'Errors and unsupported cases return a predictable result and are visible to tests or verification steps.',
      ],
      dependencies: [
        'Use the target project runtime and dependency conventions.',
        'Add new dependencies only when they are required by the approved first-iteration scope.',
      ],
      edge_cases: [
        'Required input is missing, malformed, or outside the approved first-iteration scope.',
        'Repeated or duplicate execution should have a documented behavior.',
        'Downstream or integration failure should not leave the system in an ambiguous state.',
      ],
      verification: [
        'Unit or contract tests for the primary first-iteration behavior.',
        'Regression tests for any existing behavior touched by the first iteration.',
        'A documented manual or automated verification step for the end-to-end workflow.',
      ],
    },
  };
}

function normalizedReference(reference) {
  return String(reference ?? '').replaceAll('\\', '/').replace(/^\.\//, '');
}

export function canonicalIterationSpecRef(iterationId) {
  return `iterations/${iterationId}/gate-b-spec/spec.json`;
}

export function canonicalComposedBaselineSnapshotRef(iterationId) {
  return `iterations/${iterationId}/baseline/current-spec.json`;
}

export function isComposedBaselineReference(reference) {
  const normalized = normalizedReference(reference);
  return normalized === 'current-spec.json'
    || /^iterations\/[A-Za-z0-9._-]+\/baseline\/current-spec\.json$/.test(normalized);
}

function compositionBaselineRefs(source) {
  return [
    source.metadata?.baseline?.effective_spec_ref,
    source.source_intake?.baseline_context?.spec_ref,
  ]
    .map(normalizedReference)
    .filter(Boolean);
}

function compositionBaselineRef(source) {
  return compositionBaselineRefs(source)[0] ?? null;
}

export function compositionSourceContractError(sources) {
  if (!Array.isArray(sources) || sources.length === 0) {
    return 'composition requires at least one source';
  }

  const sourceRefIndexes = new Map();
  for (const [index, source] of sources.entries()) {
    const expectedRef = canonicalIterationSpecRef(source.iteration_id);
    const normalizedSpecRef = normalizedReference(source.spec_ref);
    if (normalizedSpecRef !== expectedRef) {
      return `source ${source.iteration_id} spec_ref must be ${expectedRef}, got ${JSON.stringify(source.spec_ref)}`;
    }
    if (sourceRefIndexes.has(normalizedSpecRef)) {
      return `source spec_ref values must be unique: ${normalizedSpecRef}`;
    }
    sourceRefIndexes.set(normalizedSpecRef, index);
  }

  for (const [index, source] of sources.entries()) {
    const lineageRefs = compositionBaselineRefs(source);
    const distinctLineageRefs = [...new Set(lineageRefs)];
    if (distinctLineageRefs.length > 1) {
      return `source ${source.iteration_id} baseline provenance disagrees between iteration metadata and source intake: ${JSON.stringify(distinctLineageRefs)}`;
    }
    const precedingBaselineRefs = [];
    for (const baselineRef of lineageRefs) {
      if (isComposedBaselineReference(baselineRef)) {
        if (index === 0) {
          return `source ${source.iteration_id} composed baseline ${baselineRef} requires its preceding composition source closure`;
        }
        if (
          baselineRef !== 'current-spec.json'
          && baselineRef !== canonicalComposedBaselineSnapshotRef(source.iteration_id)
        ) {
          return `source ${source.iteration_id} composed baseline snapshot must be ${canonicalComposedBaselineSnapshotRef(source.iteration_id)}, got ${baselineRef}`;
        }
        const baselineIterationId = source.metadata?.baseline?.iteration_id;
        if (
          typeof baselineIterationId !== 'string'
          || !baselineIterationId.trim()
        ) {
          return `source ${source.iteration_id} baseline iteration_id must be a non-empty string when a composed baseline is used`;
        }
        const baselineIterationIndex = sources.findIndex(
          (candidate) => candidate.iteration_id === baselineIterationId,
        );
        if (baselineIterationIndex === -1) {
          return `source ${source.iteration_id} baseline iteration ${baselineIterationId} must be included in the preceding composition source closure`;
        }
        if (baselineIterationIndex !== index - 1) {
          return `source ${source.iteration_id} baseline iteration ${baselineIterationId} must immediately precede it in composition order`;
        }
        precedingBaselineRefs.push(baselineRef);
        continue;
      }
      const baselineIndex = sourceRefIndexes.get(baselineRef);
      if (baselineIndex === undefined) {
        return `source ${source.iteration_id} baseline ${baselineRef} must be included in the composition source closure`;
      }
      if (baselineIndex !== undefined && baselineIndex >= index) {
        return `source ${source.iteration_id} baseline ${baselineRef} must precede it in composition order`;
      }
      if (baselineIndex !== undefined) precedingBaselineRefs.push(baselineRef);
    }

    if (index === 0) continue;
    const previousOpenedAt = sources[index - 1].metadata?.opened_at;
    const openedAt = source.metadata?.opened_at;
    const hasOpenedAtOrder = (
      typeof previousOpenedAt === 'string'
      && previousOpenedAt
      && typeof openedAt === 'string'
      && openedAt
    );
    if (hasOpenedAtOrder) {
      const openedAtOrder = previousOpenedAt.localeCompare(openedAt);
      if (
        openedAtOrder > 0
        || (
          openedAtOrder === 0
          && sources[index - 1].iteration_id.localeCompare(source.iteration_id) > 0
        )
      ) {
        return `source ${source.iteration_id} opened_at precedes the prior composition source`;
      }
    }
    if (precedingBaselineRefs.length === 0 && !hasOpenedAtOrder) {
      return `source ${source.iteration_id} requires preceding baseline lineage or opened_at ordering evidence`;
    }
  }

  return null;
}

function sourceFieldRef(source, section, field) {
  return `${source.spec_ref}#${section}.${field}`;
}

function hasStaleCompositionBaseline(source, appliedSources) {
  const baselineRef = compositionBaselineRef(source);
  const lastAppliedSource = appliedSources[appliedSources.length - 1];
  if (!baselineRef) return false;
  if (isComposedBaselineReference(baselineRef)) {
    const baselineIterationId = source.metadata?.baseline?.iteration_id;
    return (
      typeof baselineIterationId === 'string'
      && baselineIterationId.trim().length > 0
      && lastAppliedSource.iteration_id !== baselineIterationId
    );
  }
  return normalizedReference(baselineRef) !== normalizedReference(lastAppliedSource.spec_ref);
}

export function compositionOpenDecisions(compositionConflicts) {
  return compositionConflicts.map((conflict, index) => ({
    id: `CD-${index + 1}`,
    type: 'composition_conflict',
    question: `Resolve current-spec composition conflict for ${conflict.field}`,
    affects: [conflict.field],
    status: 'open',
    sources: conflict.sources,
  }));
}

export function compositionReplayContractError(currentSpec, replayedComposition) {
  if (!jsonEqual(
    currentSpec.superseded_refs ?? [],
    replayedComposition.supersededRefs,
  )) {
    return 'superseded_refs must exactly match ordered source composition';
  }
  if (!jsonEqual(
    currentSpec.composition_conflicts ?? [],
    replayedComposition.compositionConflicts,
  )) {
    return 'composition_conflicts must exactly match ordered source composition';
  }
  if (!jsonEqual(
    currentSpec.open_decisions ?? [],
    compositionOpenDecisions(replayedComposition.compositionConflicts),
  )) {
    return 'open_decisions must exactly match replayed composition conflicts';
  }
  return null;
}

function applySectionComposition({
  effectiveSection,
  fieldSources,
  nextSource,
  section,
  fields,
  supersededRefs,
  compositionConflicts,
  staleBaseline,
}) {
  for (const field of fields) {
    const nextValue = nextSource.spec[section][field];
    if (jsonEqual(effectiveSection[field], nextValue)) continue;
    const previousSource = fieldSources[field];
    if (staleBaseline) {
      compositionConflicts.push({
        field: `${section}.${field}`,
        reason: 'stale_baseline',
        baseline_ref: compositionBaselineRef(nextSource),
        current_ref: previousSource.spec_ref,
        sources: [
          sourceFieldRef(previousSource, section, field),
          sourceFieldRef(nextSource, section, field),
        ],
      });
      continue;
    }
    supersededRefs.push({
      field: `${section}.${field}`,
      superseded_iteration: previousSource.iteration_id,
      superseded_ref: sourceFieldRef(previousSource, section, field),
      replaced_by_iteration: nextSource.iteration_id,
      replaced_by_ref: sourceFieldRef(nextSource, section, field),
    });
    effectiveSection[field] = cloneJson(nextValue);
    fieldSources[field] = nextSource;
  }
}

export function composeCanonicalSpecSources(sources) {
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new Error('canonical spec composition requires at least one source');
  }
  const firstSource = sources[0];
  const effectiveProduct = cloneJson(firstSource.spec.product);
  const effectiveImplementation = cloneJson(firstSource.spec.implementation);
  const productSources = Object.fromEntries(
    PRODUCT_FIELDS.map((field) => [field, firstSource]),
  );
  const implementationSources = Object.fromEntries(
    IMPLEMENTATION_FIELDS.map((field) => [field, firstSource]),
  );
  const supersededRefs = [];
  const compositionConflicts = [];
  const appliedSources = [firstSource];

  for (const nextSource of sources.slice(1)) {
    const staleBaseline = hasStaleCompositionBaseline(nextSource, appliedSources);
    applySectionComposition({
      effectiveSection: effectiveProduct,
      fieldSources: productSources,
      nextSource,
      section: 'product',
      fields: PRODUCT_FIELDS,
      supersededRefs,
      compositionConflicts,
      staleBaseline,
    });
    applySectionComposition({
      effectiveSection: effectiveImplementation,
      fieldSources: implementationSources,
      nextSource,
      section: 'implementation',
      fields: IMPLEMENTATION_FIELDS,
      supersededRefs,
      compositionConflicts,
      staleBaseline,
    });
    if (!staleBaseline) appliedSources.push(nextSource);
  }

  return {
    effectiveProduct,
    effectiveImplementation,
    supersededRefs,
    compositionConflicts,
  };
}
