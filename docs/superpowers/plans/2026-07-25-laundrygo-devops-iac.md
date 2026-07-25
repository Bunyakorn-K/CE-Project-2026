# LaundryGo DevOps and IaC Implementation Plan

> Execute with the superpowers:executing-plans skill in the current task, or use superpowers:subagent-driven-development when the user explicitly selects parallel execution.

**Goal:** Add a reproducible, least-privilege CI and observability baseline for LaundryGo, with OpenTofu provisioning for a portable Jenkins VM and repository-owned configuration for the services it hosts.

**Architecture:** The existing Pi Caddy instance remains the only public ingress. OpenTofu provisions one Jenkins VM on a parameterized Proxmox target. LaundryGo exposes metrics only on a private listener; the monitoring LXC collects metrics, logs, and traces through explicit private-network rules. Grafana remains shared, but project members receive only Viewer access in the LaundryGo organization.

**Technology:** OpenTofu 1.7+, bpg/proxmox provider, Debian cloud-init, Docker Compose, Jenkins JCasC, Hono, prom-client, OpenTelemetry, Prometheus, Loki, Tempo, OpenTelemetry Collector, Grafana, Authentik, Caddy.

**Scope boundary:** This plan does not implement machine control, payment writes, telemetry ingestion, automatic deployment, public raw-telemetry access, or a GitHub webhook. Demo data remains visibly labeled and must never become an implicit fallback.

**Preconditions:** All five gates in docs/superpowers/specs/2026-07-25-laundrygo-devops-observability-design.md section 2.3 must pass before a public route, a firewall rule, or a Proxmox apply is performed. In particular, a failing Grafana public TLS handshake, an unrotated Grafana placeholder credential, insufficient PVE local storage, or an unstable monitoring-LXC address stops the relevant rollout.

## Execution order

1. Establish non-mutating pre-flight evidence and a rollback record.
2. Add a portable, validated OpenTofu Jenkins VM module. Do not apply it yet.
3. Add Jenkins JCasC and a CI-only Compose build path that works without a local .env file.
4. Add private metrics and safe application telemetry to LaundryGo.
5. Add observability receiver, dashboards, recording rules, and alert rules.
6. Add Authentik group and provider configuration plus Grafana organization mapping runbooks.
7. Execute the approved infrastructure rollout in dependency order, then smoke-test and document rollback.

## Detailed tasks

### Task 1: Add an auditable pre-flight gate

**Files:**

- Create: infra/scripts/check-pve-preflight.sh
- Create: infra/scripts/check-observability-preflight.sh
- Create: infra/scripts/tests/check-pve-preflight.test.sh
- Create: infra/scripts/tests/check-observability-preflight.test.sh
- Create: docs/05_operations/devops-preflight.md
- Modify: .gitignore

**Implementation:**

1. Write read-only shell scripts that accept endpoint, expected hostname, capacity threshold, and fixture paths through environment variables. The scripts must not SSH, mutate Proxmox, rotate credentials, or print secret values.
2. Check the PVE local root-backed storage threshold of at least 10 GiB, the selected Jenkins VM ID is not already allocated, and required storage, bridge, and node names resolve from the supplied inventory.
3. Check Grafana HTTPS with certificate verification, confirm the configured callback hostname matches the intended public hostname, and require an operator-supplied non-secret success marker for the authenticated browser smoke test and break-glass test.
4. Record the monitoring LXC address, backup completion timestamp, Jenkins backup requirement, and existing Grafana Main-organization user mapping in an operator-only evidence file ignored by Git.
5. Add fixture-driven tests for a passing case and each stop condition: bad TLS, insufficient PVE local capacity, duplicate VM ID, missing stable monitoring address, and missing backup evidence.
6. Ignore generated pre-flight evidence, Tofu state, Tofu plans, provider caches, and all local environment files. Keep example files tracked and secret-free.

**Verify:**

1. Run the fixture tests; both scripts must return a non-zero exit code for every failed gate.
2. Run shellcheck when available and run sh -n on both scripts.
3. Run git check-ignore for a sample evidence file and a sample state file.

### Task 2: Add a portable OpenTofu Jenkins VM definition

**Files:**

- Create: infra/tofu/jenkins/versions.tf
- Create: infra/tofu/jenkins/providers.tf
- Create: infra/tofu/jenkins/variables.tf
- Create: infra/tofu/jenkins/main.tf
- Create: infra/tofu/jenkins/outputs.tf
- Create: infra/tofu/jenkins/cloud-init.yaml.tftpl
- Create: infra/tofu/jenkins/terraform.tfvars.example
- Create: infra/tofu/jenkins/README.md

**Implementation:**

1. Require OpenTofu 1.7 or newer and pin bpg/proxmox to the tested 0.110 minor range. Use native OpenTofu state and plan encryption with a PBKDF2 key provider and AES-GCM. The passphrase is a sensitive runtime input only.
2. Parameterize every environment-specific value: Proxmox endpoint, node name, API token, SSH user, bridge, storage names, VM ID, private IP/CIDR, gateway, DNS, cloud-image URL, and SSH keys. No production hostnames, API tokens, DNS tokens, or passwords may be hard-coded.
3. Model a single Debian cloud-image Jenkins VM with two vCPUs, 4 GiB RAM, and a 32 GiB disk as defaults. Cloud-init must install Docker Engine prerequisites, enable the guest agent, create a non-root deploy user, and not install Jenkins plugins or credentials.
4. Produce non-secret outputs for VM ID, VM name, and private address. Mark values that could contain credentials as sensitive.
5. Document the required order: validate only in a fresh environment, review a saved encrypted plan, apply only after pre-flight gates, verify guest backup, then allow a separate Caddy and firewall rollout.
6. Document how another environment can copy the example variables, use its own image and private network, and retain local encrypted state without committing it.

**Verify:**

1. Run tofu fmt -check.
2. Run tofu init -backend=false and tofu validate with dummy non-secret inputs or an isolated temporary data directory.
3. Inspect the rendered cloud-init output for absence of credentials and for the intended Docker and guest-agent setup.

### Task 3: Add Jenkins controller configuration and a CI-safe build path

**Files:**

- Create: infra/jenkins/compose.yaml
- Create: infra/jenkins/jenkins.yaml
- Create: infra/jenkins/plugins.txt
- Create: infra/jenkins/jenkins.env.example
- Create: infra/jenkins/README.md
- Create: compose.ci.yaml
- Create: Jenkinsfile
- Modify: .gitignore

**Implementation:**

1. Bind the Jenkins controller only to localhost on the Jenkins VM. Its public hostname is served later by Pi Caddy. Persist Jenkins home on a named host volume and set JCasC to the tracked non-secret configuration.
2. Pin Jenkins core and every plugin version. JCasC defines the minimum protected-main job shape, build discarder with fourteen-day artifacts, no anonymous administrative access, and a credentials binding by ID only. Secrets come from Jenkins credential storage or runtime environment outside Git.
3. Add an Authentik OIDC configuration template that contains issuer and callback placeholders but no client secret. Document the exact credential IDs expected by JCasC and the operator procedure for adding them.
4. Add compose.ci.yaml as an override that supplies only safe build-time values for the existing LaundryGo services. It must let a clean Jenkins checkout execute Docker Compose builds without relying on the production env_file .env.
5. Add a declarative Jenkinsfile with manual protected-main parameters and stages: checkout, Corepack enable, pnpm install with frozen lockfile, pnpm test, pnpm check, pnpm build, and Docker Compose CI build. Do not add deploy, SSH, Docker socket mounts, repository write credentials, or GitHub webhooks.
6. Add a test or static validation proving the CI override does not reference local .env files or live reporting credentials.

**Verify:**

1. Run docker compose -f compose.yaml -f compose.ci.yaml config and confirm it resolves with a blank temporary environment.
2. Run the same pnpm test, pnpm check, and pnpm build commands that Jenkins will run.
3. Validate the Jenkinsfile syntax with an available local linter or document controller-side validation as a first-boot acceptance test.

### Task 4: Expose low-cardinality private metrics and safe traces

**Files:**

- Create: apps/api/src/observability/metrics.ts
- Create: apps/api/src/observability/metrics-server.ts
- Create: apps/api/src/observability/tracing.ts
- Create: apps/api/src/observability/telemetry.ts
- Create: apps/api/src/observability/metrics.test.ts
- Modify: apps/api/src/index.ts
- Modify: apps/api/src/package.json
- Modify: apps/api/src/env.ts or the existing environment validation module
- Modify: compose.yaml
- Modify: deploy/nginx.conf

**Implementation:**

1. Add a registry with process runtime metrics plus HTTP request counters and latency histograms. Labels are limited to project, method, normalized route, and status. Use route templates, never raw paths, branch names, LIFF user IDs, request IDs, machine IDs, query values, or error text.
2. Start a separate API metrics listener with default port 9464. It serves only GET /metrics and GET /healthz on the private VM address. The public Nginx configuration must not proxy these paths.
3. Bind the Compose port to the configured LaundryGo private IP rather than all interfaces. Preserve the existing public API behavior through the web and Nginx containers.
4. Add opt-in OpenTelemetry tracing controlled by explicit environment variables. Export only to the private collector over OTLP HTTP. Propagate safe correlation IDs and redact authorization, cookie, token, and upstream credential fields from logs and spans.
5. Publish product truth with gauges or metadata: reporting configuration state, explicit demo mode, upstream freshness when supplied by the upstream contract, and unknown or unavailable for data that does not exist. Do not emit fabricated machine, revenue, or telemetry metrics.
6. Keep the existing browser credential boundary unchanged. Add tests for labels, no public metrics route, disabled tracing behavior, and secret-redaction behavior.

**Verify:**

1. Run the API unit tests and request /metrics locally on the private listener.
2. Confirm a public request to /metrics receives no metrics payload.
3. Run a log and span fixture containing authorization-like data and assert it is absent from emitted attributes.

### Task 5: Add the monitoring overlay, dashboards, and alert rules

**Files:**

- Create: infra/observability/compose.observability.yaml
- Create: infra/observability/otel-collector.yaml
- Create: infra/observability/tempo.yaml
- Create: infra/observability/prometheus/laundrygo-scrape.yaml
- Create: infra/observability/prometheus/laundrygo-rules.yaml
- Create: infra/observability/loki/laundrygo-pipeline.yaml
- Create: infra/observability/grafana/provisioning/dashboards/laundrygo.yaml
- Create: infra/observability/grafana/dashboards/laundrygo-overview.json
- Create: infra/observability/grafana/dashboards/laundrygo-operations.json
- Create: infra/observability/tests/validate-observability-config.sh
- Modify: docs/05_operations/observability.md

**Implementation:**

1. Add Tempo and an OpenTelemetry Collector as private-only services on the monitoring LXC. Tempo uses seven-day block retention. The collector uses OTLP HTTP port 4318 and a memory limiter set for the LXC resource budget.
2. Keep the existing Prometheus thirty-day and Loki fourteen-day retention settings intact. Do not change existing jobs, data sources, or alert rules unless the change is required for the LaundryGo integration.
3. Add one static LaundryGo scrape job for the VM private metrics listener. Drop unsafe labels at ingestion and attach project=laundrygo. Add a documented plan to replace the static target only after a stable monitoring address is in use.
4. Add a log pipeline that records service lifecycle and error category without request bodies, telemetry payloads, user identifiers, tokens, cookies, or upstream responses.
5. Provision two dashboards in the LaundryGo Grafana folder. The overview includes API availability, request rate, latency, errors, demo versus connected reporting state, trace links, and data limitations. The operations view includes scrape health, collector exporter health, Loki and Tempo health, and storage headroom.
6. Add non-paging or project-routed alerts for API down, scrape failure, collector export failure, Tempo unavailable, and disk headroom. Do not add telemetry stale, machine fault, revenue, or gas alerts until a verified ingestion contract exists.

**Verify:**

1. Run Docker Compose config validation and the configuration validation script.
2. Load the dashboard JSON in a disposable Grafana validation instance or use Grafana provisioning validation.
3. Send a synthetic safe trace and safe log; verify one project-labelled trace, log, and metric can be queried without sensitive content.
4. Test alert rules with a fixture or promtool when available.

### Task 6: Configure Authentik and Grafana project access without disrupting existing users

**Files:**

- Create: infra/authentik/laundrygo-blueprint.yaml
- Create: infra/authentik/README.md
- Create: infra/grafana/laundrygo-organization-runbook.md
- Create: infra/grafana/laundrygo-dashboard-access-checklist.md
- Create: infra/authentik/tests/validate-blueprint.sh

**Implementation:**

1. Add the laundrygo-members group and a Jenkins OIDC application/provider blueprint using the established Authentik blueprint conventions. Include the groups scope mapping needed by Grafana and Jenkins. Store client secrets only in Authentik and Jenkins runtime secret storage.
2. Do not modify the shared Grafana provider until a backup and a user-mapping inventory have passed the pre-flight gate. The Grafana runbook creates the LaundryGo organization, maps laundrygo-members to Viewer, keeps named platform administrators in the required organizations, and restricts folder and dashboard permissions to the project organization.
3. Record the Grafana OSS security boundary accurately: project users have UI and resource separation, not hard storage-level isolation. Restrict data-source editing and administration to platform administrators.
4. Include manual rollback steps for every identity change: disable the new provider/application, restore the recorded Grafana mapping, use break-glass administration, and confirm existing Main-organization users still sign in.
5. Write a non-secret blueprint validation test that rejects client secrets, password fields, and wild-card group assignment.

**Verify:**

1. Validate blueprint YAML and run the secrets/static policy test.
2. In a test identity, verify a laundrygo-members user has Viewer access only to LaundryGo dashboards and cannot alter data sources, users, or organization settings.
3. Verify an existing Grafana Main-organization user retains its prior intended access.

### Task 7: Roll out private connectivity and the Jenkins public route only after gates pass

**Files:**

- Modify: /Users/uunw/tryhard/notnotik/homelab/pve/notnotik-private-network-firewall.sh
- Modify: /Users/uunw/tryhard/notnotik/homelab/pve/tests/test_private_network_firewall.sh
- Modify: the existing Pi Caddy configuration in its authoritative homelab location
- Modify: docs/05_operations/devops-rollout.md

**Implementation:**

1. This task is an environment rollout, not a repository-only change. Re-run all pre-flight checks and take guest backups immediately before each mutable action.
2. Apply the reviewed Tofu plan only after validating the exact free VM ID, node, image, disk location, and stable private address. Verify the Jenkins guest agent, local-only controller listener, encrypted state handling, and first backup before exposing it.
3. Add only these reviewed private paths: monitoring LXC to LaundryGo VM TCP 9464; LaundryGo VM to monitoring LXC TCP 3100 and 4318; and Pi to Jenkins VM TCP 8080. Encode rules in the persistent firewall script and its regression test before applying the live firewall.
4. Add the jenkins.laundrygo.duckdns.org Caddy site that proxies to the Jenkins private address. Confirm certificate issuance, Authentik callback, redirect URI, and no direct public Jenkins listener. Do not add a public Grafana route because it already exists.
5. Apply the monitoring overlay, register the metrics target, configure Authentik, and provision Grafana dashboards in that dependency order. Stop and roll back the immediate change if any existing Grafana login loses access or if an unexpected public listener appears.

**Verify:**

1. From the Pi, curl each intended upstream; from an unrelated private guest, confirm each new port is refused.
2. From public Internet, verify only LaundryGo, Jenkins, Grafana, and Authentik approved hostnames respond; monitoring backends and metrics ports remain inaccessible.
3. Complete Authentik login to Jenkins and Grafana using one authorized and one unauthorized test identity.
4. Trigger the protected-main Jenkins job manually and retain the successful build artifact.

### Task 8: Complete evidence, recovery, and repository verification

**Files:**

- Create: docs/05_operations/devops-acceptance.md
- Create: docs/05_operations/backup-and-restore.md
- Modify: docs/04_traceability/RTM_matrix.md
- Modify: README.md or the current operator index when appropriate

**Implementation:**

1. Turn every verified result into a dated acceptance record without secrets: Tofu version and provider checksum, VM ID/address, guest backups, ports, route checks, test identities, Jenkins build number, dashboard URLs, and current known limitations.
2. Document distinct rollback procedures for the Jenkins VM, Caddy route, firewall rule, Authentik provider/group mapping, Grafana organization permissions, monitoring overlay, and LaundryGo API observability code. State data loss implications for each retention store.
3. Add an RTM entry only for capabilities actually implemented and verified. Keep unmet requirements explicitly open.
4. Preserve the existing local untracked draw.io file and stage only reviewed repository-owned implementation files.

**Verify:**

1. Run pnpm test, pnpm check, and pnpm build.
2. Run Tofu formatting and validation plus all script/config tests.
3. Run git diff --check and secret scanning over staged files.
4. Follow the documented restore drill in a non-production or disposable path and record its result before calling the rollout complete.

## Commit sequence

1. docs: add LaundryGo DevOps and IaC implementation plan
2. infra: add portable Jenkins OpenTofu module and pre-flight checks
3. ci: add Jenkins JCasC and hermetic LaundryGo build path
4. feat: add private LaundryGo observability endpoints
5. infra: add monitoring configuration and project dashboards
6. infra: add LaundryGo Authentik and Grafana access runbooks
7. docs: record verified DevOps rollout evidence

## Plan self-review

- Every mutable production action follows a read-only pre-flight gate and has a documented rollback path.
- Tofu manages only new Jenkins infrastructure and is portable through variables; it does not import or overwrite existing Grafana, Prometheus, Loki, Caddy, or Authentik state.
- The CI build path removes the current dependency on a production .env file.
- Metrics, traces, and logs use explicit private paths and prohibit high-cardinality or sensitive labels.
- Grafana access accurately limits UI and resource access without misrepresenting Grafana OSS as hard storage isolation.
- The plan preserves LaundryGo read-only product boundaries and delays unsupported telemetry alerts until a verified data contract exists.
