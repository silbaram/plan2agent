# Fixture: cache-library

Idea: Redis처럼 TTL과 LRU eviction을 지원하는 embeddable in-memory cache library를 만들고 싶다.

User answers for the resume path:

- ND-1: Target runtime is a TypeScript/Node.js package.
- ND-2: Single-process in-memory cache only; no network server or distributed replication.
- ND-3: Prioritize deterministic tests and simple APIs over maximum throughput.
