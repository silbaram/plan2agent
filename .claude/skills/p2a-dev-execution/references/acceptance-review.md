# Functional acceptance review

Read this reference only when `reviewPasses.acceptance` is `on`, when an independent acceptance pass was explicitly requested under `opt_in`, or when resuming an existing acceptance run. Do not use it for an envelope with a required visual contract.

After all iteration work is done and integrated, run `p2a execute accept --artifacts <artifact-root> --agent-tool <reviewer>`. This creates one `final_acceptance_review` run in the canonical workspace with `isolation.mode: none`, no changed files, and criteria derived from the current iteration's additions to Gate B `product.core_flows` and `product.success_criteria`.

The owner executes behavior commands with `p2a runs verify --run-id <id> --artifacts <root> --verify-command 'custom:<command>'`. Before invoking `p2a-acceptance-reviewer`, read the exact target run and preflight its complete `acceptanceReview.criteria` ref set, which is authoritative over the product spec or any summary. Every criterion needs evidence copyable verbatim from an executed `source: command|config` entry with `status: passed`, integer `exitCode: 0`, and meaningful `stdoutTail`; if one lacks it, record the missing behavior evidence or block the run instead of invoking the reviewer.

After the preflight passes, invoke the reviewer with the exact run path rather than restating its contract; the agent definition owns its read-only inputs and judgment rules. Save its `p2a.acceptance_review.v1` result as `<runId>.acceptance-review.json` only after confirming the returned case count and criterion ref set match the run contract exactly.

Finish requires complete coverage and `confirm_behavior`, then seals the sidecar and canonical workspace hashes. Later workspace changes require a new review. A blocked review reopens its remediation owner.
