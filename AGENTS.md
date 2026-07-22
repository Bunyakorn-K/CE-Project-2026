# IRIS Cross-Repository Workspace Guide

## Purpose and Authority

This directory is an architecture and planning workspace for the current IRIS v3
platform. It is not the application monorepo and currently has no Git history or
build system. Do not create a speculative `src/` tree here. Route implementation
work to the owning repository in `https://github.com/Meepain-group`.

This guide is based on the default branches surveyed on 2026-07-17. Repository
state can move; verify the target repository's current default branch, read its
`AGENTS.md`, and inspect the relevant implementation before changing code. Direct
user instructions take precedence over this guide.

## Product and Runtime Architecture

IRIS is one multi-tenant laundromat platform split across repositories by
deployment boundary. The current design is edge-first and offline-tolerant:
in-store operations continue during cloud disruption, while the cloud owns the
durable ledger, audit history, shared contracts, and operator-controlled config.

```text
Customer LINE/LIFF ----> iris-project cloud/API ----> payment-gateway/providers
        |                         |                         |
        |                         +---- EMQX command ------+
        |                                      |
Backoffice/browser ----> cloud control plane   v
Staff Sunmi V3 ------ LAN HTTP/WS --------> edge-agent on x86 MiniPC
                                               |
                                               +---- Modbus RTU/TCP ---- machines
                                               |
                                               +---- SQLite outbox
                                                       |
                                                       v
                                      HTTPS ingest -> Durable Objects/WS
                                                       |
                                                       v
                                                    Postgres
```

The three critical operational paths are:

1. Staff command: `IrisHandheld` calls the edge LAN API, the edge writes Modbus,
   and the handheld receives acknowledgement plus observed-state reconciliation.
2. Customer/cloud command: LIFF/cloud publishes a command through EMQX, the edge
   writes Modbus, and the response returns through the command-response path.
3. Telemetry: the edge polls machine state, persists to its SQLite outbox, flushes
   by authenticated HTTPS, and cloud state services broadcast live updates while
   Postgres retains durable history.

## Repository Ownership Map

| Repository | Responsibility | Default base |
| --- | --- | --- |
| `Meepain-group/iris-project` | Main monorepo: LIFF, backoffice, Hono cloud services, shared Zod contracts, Drizzle/Postgres, Durable Objects, webhooks, and infrastructure | `main` (workspace docs may call the canonical remote `meepain/main`) |
| `Meepain-group/edge-agent` | Rust edge runtime: Modbus RTU/TCP, LAN HTTP/WebSocket, SQLite outbox, HTTPS ingest, MQTT command bridge, branch config, and MiniPC proxy support | `origin/main` |
| `Meepain-group/IrisHandheld` | Native Kotlin/Jetpack Compose staff app for Sunmi V3 Mix; scanner, printer, WDF, local Room cache, LAN/cloud transports, and OTA client | `origin/main` |
| `Meepain-group/payment-gateway` | Independent Cloudflare Worker payment middleware for IPST/Xendit with D1, KV, Queue, webhooks, refunds, and idempotency | `origin/main` |
| `Meepain-group/aboutyou-rich-menu` | LINE OA rich-menu/profile/cover rendering and publishing pipeline | `origin/master` |
| `Meepain-group/frame-analyzer` | Read-only Python tooling and protocol evidence for Otteri Modbus reverse engineering | `origin/main` |
| `Meepain-group/iris-esp32` | ESP32-S3 payment-QR firmware scaffold; tracked as future/Phase 2 work, not a completed production path | `origin/main` |
| `Meepain-group/IrisHandheld-releases` | Public OTA APK/manifest artifacts produced by the handheld release process; not application source | `main` |
| `Meepain-group/iris-workspace-notes` | Cross-repo architecture, contracts, Git/worktree gates, orchestration rules, and workspace map | `origin/main` |

Do not confuse the Android `IrisHandheld` repository with
`iris-project/apps/iris-handheld`, which is a cloud service.

## Current Sources of Truth

- Backoffice is the operator UI; `iris-project` cloud/API, contracts, DB schema,
  authorization, and validation are the durable control plane.
- Cross-repo settings must have one versioned contract. Edge and handheld may
  cache the last-known-good config for offline operation, but money, entitlement,
  tenant isolation, and machine-start safety fail closed when stale data is unsafe.
- Postgres is the durable system of record. Durable Objects are per-machine hot
  state and WebSocket fan-out. Edge SQLite is an outbox, handheld Room is a cache,
  and payment-gateway D1/KV/Queue is a separate payment boundary.
- A LAN-connected handheld must prefer edge-observed state over delayed cloud
  state. Cloud history must not make the operational UI stale.
- The live edge-agent target is the `linux/amd64` x86 MiniPC. Pi4 is a legacy,
  observation, or bypass path; Pi5 is isolated development. Do not select a Pi as
  a deployment target without an explicit operator request.
- Exactly one process may write the RS-485 bus. Read-only capture comes first.
  The current lock mapping is R14 bit 3 = machine door and bit 2 = coinbox; decode
  the register once and derive both fields.

## Non-Negotiable Invariants

- No free start and no double debit. Financial and machine-start operations are
  atomic, authorized, tenant-scoped, idempotent, replay-safe, and reconciled.
- An acknowledgement is not final machine truth. Unknown edge outcomes enter a
  checking/reconciliation state; never guess success or failure from a timeout.
- Shared settings and workflow state are defined producer-first in
  `iris-project`; consumers must not invent local copies.
- Preserve backward compatibility for cross-repo payloads. Include tenant/branch
  scope, schema or revision, `updatedAt`, defaults, and missing-field behavior.
- Customer-facing copy calls the helper "Nong IRIS"; do not label it AI, bot, or
  chatbot. Staff/internal technical documentation may use precise technical terms.
- Never expose or persist credentials, device keys, provider secrets, live captures,
  production databases, APK signing material, or customer data in this workspace.

## How to Route Work

1. Identify the owning repository from the map above.
2. Read `iris-workspace-notes/AGENT_RULES.md`, `GITHUB-SYNC-GATE.md`, and
   `CROSS-REPO-CONTRACTS.md` for cross-repo or deployment-sensitive work.
3. Read the target repository's `AGENTS.md`, then only the relevant app/crate,
   nearby tests, and focused architecture/runbook section.
4. For cross-repo changes, implement in dependency order: shared contract/DB/API,
   backoffice edit path, consumer repositories, integration tests, then deploy plan.
5. State the source of truth, producers, consumers, delivery path, stale/offline
   behavior, compatibility plan, and acceptance tests before implementation.

## Build and Verification Entry Points

- `iris-project`: Node 22+, pnpm 10; start narrow, then use `pnpm test`,
  `pnpm check-types`, `pnpm lint`, and `pnpm build` as warranted.
- `edge-agent`: start with focused `cargo check`/`cargo test`; use
  `cargo test --workspace --all-targets` and `bash scripts/verify-local.sh` for
  the appropriate release gate.
- `IrisHandheld`: run the relevant StaffV3 Gradle unit test, lint, and assemble
  task. APK installation and OTA require the repository's device/version/hash gate.
- `payment-gateway`: `pnpm typecheck && pnpm test`; remote D1 migration and
  `wrangler deploy` require explicit approval and a rollback plan.
- `aboutyou-rich-menu`: `npm run render` plus manual image inspection; deploy is
  separate and requires explicit approval. No test or lint scripts exist.
- `frame-analyzer`: standalone Python scripts; there is no committed test or lint
  suite. Never perform a live Modbus write as part of analysis.

## Git and Deployment Rules

- GitHub is the canonical source mirror and PR review surface; local worktrees are
  the build/test/package/install/deploy runners. GitHub Actions is not the release
  gate for this platform.
- Fetch the canonical remote and start from its latest default base in a clean,
  task-specific worktree. Do not use an old handoff, branch, PR, or image tag as
  the source selector, and do not modify another agent's dirty worktree.
- Main/master changes are PR-only. Commit and push the exact locally verified SHA
  before deployment.
- Deployment, device installation, production migration, or live machine action
  requires an explicit user request, preflight evidence, checkpoint, rollback
  target, and post-change read-back/smoke test.

## Documentation Discipline

Keep this file as a short routing and invariant index. Put detailed architecture,
contracts, schemas, and runbooks in their owning repositories. Treat historical
handoffs as evidence only; current source, current config, and current default
branches win.
