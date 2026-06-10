# Intake: p2a-lightcache

## Understanding

The user wants to build an embeddable in-memory cache library with Redis-like TTL expiration and LRU eviction behavior. The clear scope is a library-style cache primitive rather than an end-user application. The open scope is which runtime the first version targets, whether Redis-like means conceptual similarity or network/API compatibility, and whether v1 should prioritize deterministic correctness or maximum throughput.

## Assumptions and risk

- **A-1 (high):** The first version can be single-process and in-memory only. This keeps the library embeddable, but it materially changes architecture if the user expects a network server or distributed behavior.
- **A-2 (medium):** A small, predictable API is more important than matching every Redis command. This keeps v1 manageable, but it needs confirmation because full API compatibility would expand acceptance criteria.

## Decisions blocking the next stage

| Decision | Question | Recommended option | Rationale | Blocks |
| --- | --- | --- | --- | --- |
| ND-1 | Which runtime should v1 target? | TypeScript/Node.js | A typed npm package gives a concrete API, packaging, timer model, and test harness for the first implementation plan. | `spec.product.screens_or_interfaces`, `spec.implementation.architecture` |
| ND-2 | Should v1 include network server or distributed behavior? | Single process only | This matches an embeddable library and avoids turning v1 into a Redis server clone. | `spec.product.goals`, `spec.product.non_goals` |
| ND-3 | What should v1 optimize for? | Simple and deterministic | Deterministic tests and clear behavior are better first-version success criteria than benchmark-driven optimization. | Acceptance criteria and task graph sizing |

Gate A remains blocked until the user answers the open decisions above.
