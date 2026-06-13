# Product Spec

Build a backend webhook ingestion API that accepts partner callbacks, validates authenticity, normalizes payloads into internal events, and delivers them through a provider-neutral queue adapter.

The v1 product exposes `POST /webhooks/:partner`, uses HMAC SHA-256 signatures with timestamp tolerance, and treats concrete cloud queue providers, admin UI, historical replay, and long-term event storage as non-goals.
