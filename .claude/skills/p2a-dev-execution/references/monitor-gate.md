# Monitor gate

Read this reference only for a run already started with `--require-monitor`. `reviewPasses.monitor: opt_in` uses that flag as the activation signal; `off` prevents new opt-ins.

Invoke `p2a-performance-monitor` as a separated read-only pass. Pass the task id, acceptance criteria, latest run log, complete `.monitor-gate.json`, every changed file, and the complete approved rule source bound by `ruleContract.ref` and `ruleContract.sha256`, normally `.plan2agent/constitution.json` or an older `.plan2agent/style.md`. The agent definition owns the verdict shape and judgment rules; do not restate or reinterpret them.

Write the returned object unchanged as `<runId>.monitor-verdict.json` beside the run. The CLI checks rule coverage, maps concern arrays to the failure class, and seals the exact verdict bytes at finish; never edit a sealed verdict. When the verdict is `block`, finish the run with monitor-sourced structured failure metadata and do not mark the task done.
