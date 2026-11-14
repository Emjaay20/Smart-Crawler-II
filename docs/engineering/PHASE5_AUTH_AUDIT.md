# Phase 5 — Enterprise authentication guard and audit foundation

**Parent:** Phase 4 PR #9  
**Status:** Draft implementation; not a completed compliance or IAM program.

## Security invariant

API-key authentication must not depend on whether a separate administrator token exists. Before this change the application defined `authOn` only when **both** the key store and admin token were present, potentially leaving protected APIs open if the administrator token was omitted.

Now `authOn` follows `Boolean(deps.keys)`. Requests require a valid key or the explicitly configured guest-demo allowance whenever a key store is present. Without the admin token, administrative endpoints remain unavailable (501). This is a **behavioral change** and needs rollout review, particularly on deployments that had an improperly unprotected API configuration.

## Minimal administrative audit

`AuditStore` uses SQLite `audit_events` to record selected mutation outcomes:
- Administrator API-key creation/revocation
- Account API-key creation/revocation
- Administrator-approved interrupted-crawl resumption

The protected `GET /v1/admin/audit?limit=50` endpoint returns the latest events, at most 100 records. It requires the admin bearer token and sets `Cache-Control: no-store`.

Each event stores an opaque resource ID, action, actor type, optional account ID and timestamp. It **never stores the raw API key, admin bearer token, proxy credentials, request body, user URL or IP address**.

This is an audit **foundation only**, not a complete security or regulatory evidence system. Events live inside the same SQLite database and are not tamper-evident. There is no enforced immutable retention, externally shipped append-only archive, audit-event signing, SOC 2 claim, role-based administrator separation, or SAML/SCIM integration. A database administrator may modify these events. Mutations and audit inserts are not yet a single database transaction, so a write failure requires operational reconciliation.

## Verification

- Key store present with no admin token still enforces normal API authentication.
- Administrator key mutation events appear in the expected order.
- Sensitive key and bearer values are absent from audit responses.
- Unauthenticated audit reads are blocked.
- History listing is bounded and opaque resource identifier validation rejects raw URLs/secrets.
- Full existing test and Docker suite still passes.

## Required production gates

Verify old environment configuration, HTTPS, reverse-proxy trust, live key issuance policies, guest-demo limits, backup/restore, approval process and immutable audit export architecture before deploying. This branch must not be merged independently of Phase 1–4 dependencies.

## Application evidence

Describe this narrowly as **fail-closed API-key initialization and initial credential-free audit logging**. Do not state enterprise readiness, regulatory compliance or security certification without an independent audit.
