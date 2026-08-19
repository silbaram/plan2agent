/** Shared canonical spec seed and composition rules. */

export const PRODUCT_FIELDS = [
  'problem',
  'target_users',
  'goals',
  'must_preserve',
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

export function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

export function jsonEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function asStringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

export function appendUnique(values, additions) {
  const next = [...asStringArray(values)];
  for (const addition of additions) {
    if (addition && !next.includes(addition)) next.push(addition);
  }
  return next;
}

const SPEC_FIELD_REF_PATTERN = /^spec\.(product|implementation)\.([a-z_]+)$/;
const SUPERSESSION_DISPOSITION_PATTERN = /^superseded_by_[a-z0-9][a-z0-9._-]*$/;
const RESTRICTIVE_SPEC_FIELD_REFS = [
  'spec.product.non_goals',
  'spec.product.constraints',
  'spec.implementation.architecture',
  'spec.implementation.interfaces',
];
const CONTRADICTION_RESTRICTIVE_FIELD_REFS = [
  'spec.product.non_goals',
];
const CONTRADICTION_POSITIVE_FIELD_REFS = [
  'spec.product.goals',
];
const CAPABILITY_STOP_WORDS = new Set([
  'actual',
  'adapter',
  'adapters',
  'approved',
  'baseline',
  'behavior',
  'behaviour',
  'capabilities',
  'capability',
  'context',
  'contexts',
  'current',
  'feature',
  'features',
  'from',
  'full',
  'gate',
  'implementation',
  'implementations',
  'implemented',
  'implements',
  'interface',
  'interfaces',
  'into',
  'iteration',
  'only',
  'product',
  'provider',
  'providers',
  'queue',
  'queues',
  'provide',
  'provided',
  'provides',
  'providing',
  'public',
  'scope',
  'scoped',
  'service',
  'services',
  'support',
  'supported',
  'supporting',
  'supports',
  'system',
  'systems',
  'that',
  'these',
  'this',
  'those',
  'through',
  'with',
  'workflow',
  'workflows',
]);
const CONTRADICTION_CAPABILITY_TOKENS = new Set([
  'compile',
  'eval',
  'lint',
  'query',
  'retrieval',
  'search',
]);
const RESTRICTIVE_TEXT_PATTERN = /(?:\b(?:defer(?:red|s|ring)?|disallow(?:ed|s)?|exclude(?:d|s)?|forbid(?:den|s)?|must\s+not|never|no|not|only|out\s+of\s+scope|unsupported|without)\b|범위\s*밖|비목표|미지원|지원하지|제외|금지|후속\s*(?:반복|iteration))/i;
const CAPABILITY_QUALIFIER_RULES = [
  {
    dimension: 'scope',
    value: 'cross-project',
    pattern: /\bcross[- ]project\b|(?:\bproject|프로젝트)\s*간/i,
  },
  {
    dimension: 'scope',
    value: 'project-scoped',
    pattern: /\b(?:per[- ]project|project[- ]scoped|projectid[- ]only|single[- ]project)\b|(?:\bproject|프로젝트)\s*별/i,
  },
  {
    dimension: 'provider',
    value: 'specific',
    pattern: /\bprovider[- ]specific\b|provider\s*별/i,
  },
  {
    dimension: 'provider',
    value: 'neutral',
    pattern: /\bprovider[- ]neutral\b/i,
  },
  {
    dimension: 'surface',
    value: 'cli',
    pattern: /\b(?:cli|command[- ]line)\b/i,
  },
  {
    dimension: 'surface',
    value: 'sdk',
    pattern: /\bsdk\b/i,
  },
  {
    capabilities: new Set(['query']),
    dimension: 'query-mode',
    value: 'saved',
    pattern: /\bquery\b.{0,48}\b(?:save\s+mode|save\s*[:=]\s*true|saved\s+mode)\b/i,
  },
  {
    capabilities: new Set(['eval']),
    dimension: 'eval-mode',
    value: 'recorded',
    pattern: /\beval(?:uation)?\b.{0,48}\b(?:history\s+record(?:ing)?|record(?:ing)?\s+mode|record\s*[:=]\s*true)\b/i,
  },
  {
    capabilities: new Set(['retrieval']),
    dimension: 'retrieval-mode',
    value: 'orchestration',
    pattern: /\bretrieval\b.{0,48}\borchestration\b/i,
  },
];

function normalizedCapabilityToken(token) {
  const normalized = token.toLowerCase().replace(/^-+|-+$/g, '');
  if (/^(?:compiler|compilers|compilation|compilations)$/.test(normalized)) return 'compile';
  if (/^(?:retrieve|retriever|retrievers|retrieving)$/.test(normalized)) return 'retrieval';
  if (/^(?:searches|searching|searched)$/.test(normalized)) return 'search';
  if (/^(?:queries|querying|queried)$/.test(normalized)) return 'query';
  if (/^(?:evaluate|evaluates|evaluated|evaluating|evaluation|evaluations)$/.test(normalized)) return 'eval';
  if (/^(?:linted|linting|linter|linters)$/.test(normalized)) return 'lint';
  if (normalized === 'statuses') return 'status';
  if (normalized === 'contexts') return 'context';
  return normalized;
}

export function capabilityTokens(text) {
  if (typeof text !== 'string') return [];
  const normalizedText = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase();
  const tokens = normalizedText.match(/[a-z][a-z0-9-]{2,}/g) ?? [];
  return [...new Set(tokens
    .flatMap((token) => token.split('-'))
    .map(normalizedCapabilityToken)
    .filter((token) => token.length >= 4 && !CAPABILITY_STOP_WORDS.has(token)))];
}

function normalizedContradictionCapabilityToken(token) {
  const normalized = token.toLowerCase().replace(/^-+|-+$/g, '');
  if (/^(?:compile|compiled|compiles|compiling|compilation|compilations)$/.test(normalized)) {
    return 'compile';
  }
  if (/^(?:retrieve|retrieval|retriever|retrievers|retrieving)$/.test(normalized)) {
    return 'retrieval';
  }
  if (/^(?:search|searches|searching|searched)$/.test(normalized)) return 'search';
  if (/^(?:query|queries|querying|queried)$/.test(normalized)) return 'query';
  if (/^(?:eval|evaluate|evaluates|evaluated|evaluating|evaluation|evaluations)$/.test(normalized)) {
    return 'eval';
  }
  if (/^(?:lint|linted|linting|linter|linters)$/.test(normalized)) return 'lint';
  return normalized;
}

function contradictionCapabilityTokens(text) {
  if (typeof text !== 'string') return [];
  const normalizedText = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase();
  const tokens = normalizedText.match(/[a-z][a-z0-9-]{2,}/g) ?? [];
  return [...new Set(tokens
    .flatMap((token) => token.split('-'))
    .map(normalizedContradictionCapabilityToken)
    .filter((token) => CONTRADICTION_CAPABILITY_TOKENS.has(token)))];
}

export function isSupersedingDecision(decision) {
  return (
    typeof decision?.disposition === 'string'
    && SUPERSESSION_DISPOSITION_PATTERN.test(decision.disposition)
  );
}

export function supersedingDecisionResolution(decision) {
  if (!isSupersedingDecision(decision)) return null;
  if (typeof decision.current_resolution === 'string' && decision.current_resolution.trim()) {
    return decision.current_resolution.trim();
  }
  return null;
}

export function decisionAffectedSpecRefs(decision) {
  const preferred = Array.isArray(decision?.affected_fields) && decision.affected_fields.length
    ? decision.affected_fields
    : decision?.blocks;
  return [...new Set((Array.isArray(preferred) ? preferred : [])
    .filter((reference) => typeof reference === 'string' && SPEC_FIELD_REF_PATTERN.test(reference)))];
}

function canonicalSpecSections(spec) {
  if (spec?.product && spec?.implementation) {
    return { product: spec.product, implementation: spec.implementation };
  }
  if (spec?.effective_product && spec?.effective_implementation) {
    return {
      product: spec.effective_product,
      implementation: spec.effective_implementation,
    };
  }
  return null;
}

function specFieldValue(spec, fieldRef) {
  const match = SPEC_FIELD_REF_PATTERN.exec(fieldRef);
  const sections = canonicalSpecSections(spec);
  if (!match || !sections) return undefined;
  return sections[match[1]]?.[match[2]];
}

function stringEntriesForField(spec, fieldRef) {
  const value = specFieldValue(spec, fieldRef);
  if (Array.isArray(value)) {
    return value
      .map((text, index) => ({ fieldRef, index, text }))
      .filter((entry) => typeof entry.text === 'string' && entry.text.trim());
  }
  if (typeof value === 'string' && value.trim()) {
    return [{ fieldRef, index: null, text: value }];
  }
  return [];
}

function isRestrictiveEntry(entry) {
  return (
    entry.fieldRef === 'spec.product.non_goals'
    || RESTRICTIVE_TEXT_PATTERN.test(entry.text)
  );
}

function sharedCapabilities(left, right) {
  const rightTokens = new Set(capabilityTokens(right));
  return capabilityTokens(left).filter((token) => rightTokens.has(token));
}

function sharedContradictionCapabilities(left, right) {
  const rightTokens = new Set(contradictionCapabilityTokens(right));
  return contradictionCapabilityTokens(left).filter((token) => rightTokens.has(token));
}

function capabilityQualifierDimensions(text, capability) {
  const dimensions = new Map();
  for (const rule of CAPABILITY_QUALIFIER_RULES) {
    if (rule.capabilities && !rule.capabilities.has(capability)) continue;
    if (!rule.pattern.test(text)) continue;
    const values = dimensions.get(rule.dimension) ?? new Set();
    values.add(rule.value);
    dimensions.set(rule.dimension, values);
  }
  return dimensions;
}

function isQualifiedNonConflict(restrictiveText, positiveText, capability) {
  if (/\b(?:except|excluding|other\s+than|beyond)\b/i.test(restrictiveText)) {
    return true;
  }
  const restrictiveDimensions = capabilityQualifierDimensions(restrictiveText, capability);
  if (!restrictiveDimensions.size) return false;
  const positiveDimensions = capabilityQualifierDimensions(positiveText, capability);
  for (const [dimension, restrictiveValues] of restrictiveDimensions) {
    const positiveValues = positiveDimensions.get(dimension);
    if (!positiveValues) return true;
    if (![...restrictiveValues].some((value) => positiveValues.has(value))) return true;
  }
  return false;
}

function inferredSupersessionCandidates(baselineSpec, decision) {
  const resolution = supersedingDecisionResolution(decision);
  if (!resolution) return [];
  const resolutionCapabilities = new Set(capabilityTokens(resolution));
  if (!resolutionCapabilities.size) return [];
  return RESTRICTIVE_SPEC_FIELD_REFS
    .flatMap((fieldRef) => stringEntriesForField(baselineSpec, fieldRef))
    .filter(isRestrictiveEntry)
    .map((entry) => ({
      ...entry,
      capabilities: capabilityTokens(entry.text)
        .filter((token) => resolutionCapabilities.has(token)),
    }))
    .filter((entry) => entry.capabilities.length > 0);
}

function declaredSupersessionTargets(decision) {
  return (Array.isArray(decision?.supersedes) ? decision.supersedes : [])
    .filter((target) => (
      typeof target?.field_ref === 'string'
      && SPEC_FIELD_REF_PATTERN.test(target.field_ref)
      && typeof target?.baseline_value === 'string'
      && target.baseline_value.trim()
    ));
}

function explicitSupersessionCandidates(baselineSpec, decision) {
  const targets = declaredSupersessionTargets(decision);
  const candidates = [];
  const invalidTargets = [];
  for (const target of targets) {
    const match = stringEntriesForField(baselineSpec, target.field_ref)
      .find((entry) => entry.text === target.baseline_value && isRestrictiveEntry(entry));
    if (!match) {
      invalidTargets.push(target);
      continue;
    }
    candidates.push({
      ...match,
      capabilities: sharedCapabilities(match.text, supersedingDecisionResolution(decision) ?? ''),
    });
  }
  return { targets, candidates, invalidTargets };
}

export function planBaselineSupersessions(baselineSpec, intake) {
  const decisions = (intake?.needs_user_decision ?? []).filter(isSupersedingDecision);
  const plans = decisions.map((decision) => {
    const explicit = explicitSupersessionCandidates(baselineSpec, decision);
    const hasExplicitTargets = explicit.targets.length > 0;
    return {
      decision,
      resolution: supersedingDecisionResolution(decision),
      affectedFields: decisionAffectedSpecRefs(decision),
      candidates: hasExplicitTargets
        ? explicit.candidates
        : inferredSupersessionCandidates(baselineSpec, decision),
      hasExplicitTargets,
      invalidTargets: explicit.invalidTargets,
      requiresExplicitTargets: !hasExplicitTargets,
    };
  });
  return {
    plans,
    unresolved: plans.filter((plan) => (
      !plan.resolution
      || plan.candidates.length === 0
      || plan.invalidTargets.length > 0
      || plan.requiresExplicitTargets
    )),
  };
}

export function applyBaselineSupersessions(baselineSpec, intake) {
  const sections = canonicalSpecSections(baselineSpec);
  if (!sections) {
    return { product: null, implementation: null, plans: [], unresolved: [] };
  }
  const { plans, unresolved } = planBaselineSupersessions(baselineSpec, intake);
  const product = cloneJson(sections.product);
  const implementation = cloneJson(sections.implementation);
  const removals = new Map();
  const applicablePlans = plans.filter((plan) => (
    plan.resolution
    && plan.hasExplicitTargets
    && plan.invalidTargets.length === 0
    && plan.candidates.length > 0
  ));
  for (const plan of applicablePlans) {
    for (const candidate of plan.candidates) {
      const indexes = removals.get(candidate.fieldRef) ?? new Set();
      indexes.add(candidate.index);
      removals.set(candidate.fieldRef, indexes);
    }
  }
  const next = { product, implementation };
  for (const [fieldRef, indexes] of removals) {
    const match = SPEC_FIELD_REF_PATTERN.exec(fieldRef);
    const values = next[match[1]][match[2]];
    next[match[1]][match[2]] = values.filter((_, index) => !indexes.has(index));
  }
  return { ...next, plans, unresolved };
}

export function baselineSupersessionViolations(baselineSpec, intake, currentSpec) {
  const { plans } = planBaselineSupersessions(baselineSpec, intake);
  const validationUnresolved = plans.filter((plan) => (
    !plan.resolution
    || plan.candidates.length === 0
    || plan.invalidTargets.length > 0
  ));
  const violations = validationUnresolved.map((plan) => ({
    kind: 'unresolved',
    decisionId: plan.decision.id,
    disposition: plan.decision.disposition,
    affectedFields: plan.affectedFields,
    capabilities: capabilityTokens(plan.resolution ?? ''),
    invalidTargets: plan.invalidTargets,
  }));
  for (const plan of plans) {
    for (const candidate of plan.candidates) {
      const currentValue = specFieldValue(currentSpec, candidate.fieldRef);
      if (Array.isArray(currentValue) && currentValue.includes(candidate.text)) {
        violations.push({
          kind: 'retained_baseline_item',
          decisionId: plan.decision.id,
          disposition: plan.decision.disposition,
          fieldRef: candidate.fieldRef,
          baselineText: candidate.text,
          capabilities: candidate.capabilities,
        });
      }
    }
  }
  return violations;
}

export function findSpecCapabilityContradictions(spec) {
  const restrictiveEntries = CONTRADICTION_RESTRICTIVE_FIELD_REFS
    .flatMap((fieldRef) => stringEntriesForField(spec, fieldRef))
    .filter(isRestrictiveEntry);
  const positiveEntries = CONTRADICTION_POSITIVE_FIELD_REFS
    .flatMap((fieldRef) => stringEntriesForField(spec, fieldRef))
    .filter((entry) => !isRestrictiveEntry(entry));
  const contradictions = [];
  const seen = new Set();
  for (const restrictive of restrictiveEntries) {
    for (const positive of positiveEntries) {
      const shared = sharedContradictionCapabilities(restrictive.text, positive.text);
      for (const capability of shared) {
        if (isQualifiedNonConflict(restrictive.text, positive.text, capability)) continue;
        const key = `${capability}\n${restrictive.fieldRef}\n${restrictive.index}\n${positive.fieldRef}\n${positive.index}`;
        if (seen.has(key)) continue;
        seen.add(key);
        contradictions.push({ capability, restrictive, positive });
      }
    }
  }
  return contradictions;
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
      must_preserve: [
        'Preserve existing behavior outside the approved first-iteration scope.',
        'Preserve existing data and public interfaces unless Gate B explicitly approves a change.',
      ],
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
    const nextValue = nextSource.spec[section][field]
      ?? (section === 'product' && field === 'must_preserve' ? [] : undefined);
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
  effectiveProduct.must_preserve ??= [];
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
