# Execution Preparation and Lifecycle

Read the relevant section when preparing Direct/Planned execution or starting/resuming a single-owner run.

## Adaptive preparation

When `--prepare-mode` is present and Gate C is absent, inspect the approved Gate B envelope, repository topology, existing verification commands, external boundaries, and likely recovery surface. Select the mode as an implementation decision:

- `direct`: one owner, localized change, low uncertainty, no risky external side effect, and one bounded verification cycle.
- `planned`: one owner, but two to five ordered, resume-safe checkpoints materially improve recovery.
- `orchestrated`: independent owners, meaningful parallelism, high coordination or isolation needs, or a dependency graph materially improves recovery.

`--prepare-mode direct|planned` fixes the permitted mode. `--prepare-mode adaptive` allows all three. Record a concise evidence-based rationale.

Direct preparation:

```bash
p2a execute prepare --artifacts <dir> --mode direct \
  --selection-rationale '<why one bounded work item is sufficient>'
```

Planned preparation declares two to five ordered checkpoints with observable outcomes and executable commands:

```bash
p2a execute prepare --artifacts <dir> --mode planned \
  --selection-rationale '<why ordered checkpoints improve recovery>' \
  --milestone 'milestone-1|<observable outcome>|<verification command>' \
  --milestone 'milestone-2|<observable outcome>|<verification command>'
```

The CLI writes one synthetic compatibility work item and validates Gate C readiness. Do not add another human Gate C approval. If adaptive inspection selects `orchestrated`, continue with `p2a-task-author --artifacts <dir>` for an active iteration, or the `p2a-task-breakdown --artifacts <dir>` compatibility entry for a flat root. Continue execution only after that owner persists and validates the graph.

## Inspect readiness and retry evidence

Use the same ready snapshot and read the Gate-derived execution envelope before task prose:

```bash
p2a tasks ready --artifacts <dir>
```

The envelope source hash, objective, scope, `mustPreserve`, non-goals, `iterationConstraints`, acceptance, verification, authority, and visual contract are canonical. Apply the current iteration's architecture, interface, and dependency constraints even when the project has no constitution. The work item is only an ownership and recovery boundary.

For a retry whose latest run is `failed` or `blocked`, inspect that local run's failure class, localization, and verification evidence before starting. Relevant project memory may supplement that evidence, not replace it; apply only a clearly similar mitigation and keep its inspected source reference in existing run notes.

## Optional project memory

When `buildlore.enabled` is true and prior knowledge is relevant, make one bounded `p2a buildlore memory --task '<current goal>' --progressive --json` query at start, resume, or a meaningful direction change, and reuse what was already read. Fetch a needed source with `p2a buildlore lookup --kind evidence --id <canonical-id> --expect-generation <returned-generation> --json`, using the registry's canonical ID rather than its short alias. Stay within the current project and one generation.

Memory is history, not proof: only a recorded `codeRevision` that matches the current code shows verified behavior, and a past decision grants no new execution authority. Unavailable, empty, or stale results are not blockers; continue from current code, the latest user request, and the approved contract, and report an unmet requirement only when that contract explicitly requires historical knowledge. Retrieval never authorizes synchronization, generation, compilation, commit, publication, or other knowledge writes.

## Progress and direction advice

Keep the user oriented at meaningful moments: a usable outcome is implemented or verified, a consequential choice or new fact appears, failures repeat, scope grows, or the user asks about status. A few sentences are usually enough; do not report every edit or tool call.

For an active or recoverable blocked run, `p2a next --json --contract v2` includes a read-only `briefing`; ground progress in its source pointers. `reportedChanges` are owner reports and `completionCriteria` are requirements, not an assessment of their completion. Only executed current passes support a current check claim; historical or unknown checks need fresh evidence. The briefing never replaces `command` as routing authority, and a passing command alone does not establish every acceptance criterion.

When something threatens the user's goal, such as unnecessary structure or dependencies, repeated fixes without testing the cause, or tests unlike real usage, explain **observation → impact on the goal → advice → next authorized action**, keeping current facts, previous memory, and inference distinct. Advice does not mark work blocked or failed, create an approval gate, start another reviewer, or require a report; continue authorized development. If the user defers or chooses differently, do not repeat the same recommendation without new evidence. A changed direction goes through the existing contract-update path.

Record a reusable decision, observed lesson, or unresolved follow-up in the existing run with `p2a runs record --artifacts <dir> --run-id <id> --note 'decision: <choice and recorded reason>'`, `lesson: <observation and its limits>`, or `remaining: <unresolved follow-up>`. These labelled notes are owner reports, not approval or executed proof; completion capture extracts them with source pointers. Use the structured failure-detail options for diagnosis, correction, and recurrence checks.

Describe progress as user-visible capabilities and verified scope, not percentages guessed from file or task counts; test definitions are not executed evidence. At completion, separate implemented outcomes, actual verification, and unresolved issues.

## Start or resume the run

Start through the execution lifecycle so run creation and task ownership change atomically:

```bash
p2a execute start --artifacts <dir> --task <id> --agent-tool <implementer>
```

Set `<implementer>` to the tool actually doing the work: `claude`, `codex`, or `manual`. The CLI defaults to `codex`, so pass it explicitly; Gemini may only review.

Preserve one run id across start retries. On the first start omit `--run-id` so the CLI allocates it; if start or isolation setup fails, use the retry command the CLI prints, which keeps the same explicit id, rather than starting a new attempt.

Read `devExecution.reviewPasses.monitor` before start. Pass `--require-monitor` only when policy or the approved contract requires it. Let `runTracking.defaultIsolation` select the default. For a justified worktree use:

```bash
p2a execute start --artifacts <dir> --task <id> --agent-tool <implementer> \
  --isolation worktree --worktree <fresh-worktree-path> --create-isolation
```

Use `p2a execute resume` for an existing open run. Resume, verify, checkpoint, and finish revalidate the recorded Gate B/Gate C contract. If the source changed or disappeared, restore an accidental change or close the stale run with structured failure evidence before approving replacement work.

## Implement

Use CLI-provided evidence paths. An additional run report goes in `<artifact-root>/evidence/<iteration-id>/<run-id>/report.md` (maintenance uses `maintenance` as its iteration id), with optional `logs/` and `attachments/`; never add topic/date folders at the artifact root. Keep one run across ordinary corrections and give each new attempt an unused filename such as `logs/test-02.log` so earlier evidence survives.

Create temporary installs, source copies and package archives with unique task-owned directories under `.plan2agent/tmp/` inside the permitted workspace, or reuse an existing tool's OS-temp lifecycle. When copying sources, exclude the destination and `.plan2agent` to avoid recursive copies, and omit unneeded `.git`, `node_modules`, and build output. Temporary paths must not be the sole source of completion evidence.

Before editing, inventory the source baseline and unrelated user changes. If pre-existing untracked files make `--collect-git` ambiguous, record the inventory and pass exact task-owned `--changed-file` values at finish.

The current owner implements Direct and ordinary single-owner Planned work. Spawn `p2a-implementer` only when an independently confined owner materially helps Orchestrated/batch work or explicit context isolation. A spawned implementer edits only its scope and may run local checks, but lifecycle verification and finish remain with the owner.

Own the envelope objective, inspect the repository, choose internal structure, implement, run checks, and correct ordinary code/test/UI drift without asking the user to choose implementation details. Before finish, compare the implementation and changed dependencies/interfaces with `iterationConstraints`; a conflict is not a successful implementation even when commands pass. Return to Gate B only when the objective requires changing product meaning, acceptance, approved scope, an approved iteration constraint, or constitution. Handle external authorization through `provider-confinement.md` without product reapproval.
