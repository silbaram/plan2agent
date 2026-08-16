# CE-010 Final Runtime Context Routing A/B

## Verdict

Codex `gpt-5.6-luna` / `medium` final feature-toggle A/B completed with `provider_limited` verdict. All 30 baseline/candidate runs passed their behavioral grade, trace coverage was complete, and all 10 declared performance checks passed.

The treatment compared byte-identical current source trees:

- baseline: legacy model-routed reference loading
- candidate: host-supplied resolver-selected context packets

The frozen performance reference is `CE-010-runtime-routing-baseline-regraded/codex/codex-trace-summary.json`.

## Results against the frozen reference

| Metric | Frozen reference | Final candidate | Change |
| --- | ---: | ---: | ---: |
| Total input tokens | 783,721 | 579,234 | -26.09% |
| Uncached input tokens | 289,129 | 231,330 | -19.99% |
| Output tokens | 14,633 | 10,500 | -28.24% |
| Elapsed | 396,332 ms | 284,990 ms | -28.09% |
| Tool operations | 38 | 23 | -39.47% |
| Repeated source reads | 0 | 0 | unchanged |
| Unknown operations | 0 | 0 | unchanged |

Scenario medians:

- Direct input: 43,282 → 30,255 (-30.10%); tool operations: 2 → 1.
- Planned input: 44,816 → 30,165 (-32.69%); tool operations: 3 → 1.
- Gate B input: 42,428 → 42,536 (+0.25%); this scenario intentionally received no runtime packet.

## Notable observation

Candidate Planned repetition 5 passed but used 93,602 input tokens and four read operations. Three reads had no allowlisted source id; raw commands were intentionally not retained by the sanitized trace contract. The run did not reopen the packet-managed lifecycle source, did not create an unknown operation, and did not affect the declared median or aggregate gates.

## Evidence integrity and coverage

- `codex/codex-ab-summary.json` binds all 30 result, grade, and metadata files by SHA-256.
- All referenced hashes were rechecked after execution with no mismatch.
- No provider transcript, raw command, credential, or command output body is stored.
- Claude and Gemini behavioral calls were not approved or executed. This evidence therefore remains `provider_limited` and is not a cross-provider `go` decision.
