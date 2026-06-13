# Implementation Plan

Implement a small TypeScript HTTP service. Keep request verification, payload normalization, queue delivery, retry policy, and dead-letter handling in separate modules.

Use raw request bodies for HMAC verification, deterministic fake adapters for tests, and a bounded retry policy before recording exhausted deliveries to the dead-letter adapter.
