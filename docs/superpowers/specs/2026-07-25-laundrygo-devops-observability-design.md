# LaundryGo DevOps and Observability Design

**Status:** Approved for implementation

**Date:** 2026-07-25

## 1. Purpose

This design adds a project-scoped DevOps and observability baseline for
LaundryGo without changing its product boundary. LaundryGo remains a
read-mostly reporting application. This work does not introduce machine
commands, payment writes, unverified telemetry semantics, or public access to
raw telemetry stores.

The baseline must provide:

- Jenkins CI for repeatable application verification.
- Grafana dashboards for LaundryGo project members.
- Loki logs, Prometheus metrics, and Tempo traces for LaundryGo services.
- Authentik-based access control through a `laundrygo-members` group.
- Public access only for the approved user interfaces.

## 2. Decisions and Constraints

### 2.1 Confirmed decisions

- Grafana remains the existing shared Grafana instance at
  `grafana.notnotik.duckdns.org`.
- LaundryGo members are not an untrusted external tenant. The design provides
  Grafana resource and dashboard separation, not hard storage-level isolation
  from the shared Prometheus and Loki backends.
- Authentik is the identity provider. Administrators manage project access by
  maintaining the `laundrygo-members` group.
- Jenkins is exposed at `jenkins.laundrygo.duckdns.org` and uses Authentik
  OpenID Connect.
- The first CI release has no automatic deployment stage. A successful build
  creates a verified candidate only.
- Grafana, Loki, and Prometheus are reused. Tempo and an OpenTelemetry
  Collector are added to complete the traces path.
- The initial Jenkins trigger is manual for the protected `main` branch only.
  A public GitHub webhook is a separate, later change with its own signature
  validation and authorization design.

### 2.2 Existing constraints

- The public LaundryGo application runs on VM 117 at `10.10.0.117`; Caddy on
  the Pi is the public reverse proxy.
- The existing monitoring LXC hosts Grafana, Loki, Prometheus, Alertmanager,
  and related services.
- PVE `local` storage is effectively full. It must have at least 10 GiB free
  before new infrastructure is provisioned or changed. No ISO, archive, or
  image is deleted or moved without a separately confirmed target.
- PVE `local-lvm` has capacity for workloads, but capacity alone does not
  remove the host-root storage blocker.
- The monitoring LXC currently uses DHCP. It needs a DHCP reservation or a
  static private address before it becomes a firewall-rule source.
- All new Caddy upstreams and cross-network monitoring ports must be reflected
  in the persistent PVE private-network firewall and its regression test.
- Browser clients never receive upstream service credentials.

### 2.3 Mandatory pre-flight gates

No implementation or public route change starts until all of these checks pass:

1. `grafana.notnotik.duckdns.org` completes a public TLS handshake and an
   authenticated browser smoke test. The effective Grafana `root_url`, Caddy
   route, certificate, and Authentik callback are recorded without printing
   secrets.
2. The live Grafana administrator credential is confirmed rotated from any
   source-controlled placeholder. It is stored outside Git with restrictive
   file permissions. The local break-glass procedure is tested before OAuth
   changes.
3. PVE `local` has at least 10 GiB free after an explicitly approved recovery
   action. The recovery record identifies each retained, moved, or removed
   artifact and its rollback location.
4. The monitoring LXC has a stable private address, current resource
   measurements, and a successful guest backup. Jenkins receives a stable
   private address and must complete its first successful guest backup before
   its public Caddy route is exposed.
5. Existing Grafana OAuth users and the current Main organization mapping are
   inventoried. The LaundryGo mapping may not revoke existing authorized
   administrators as an accidental side effect.

## 3. Architecture

```text
Project member
    |
    +--> Authentik
    |      `-- laundrygo-members group
    |
    +--> grafana.notnotik.duckdns.org
    |      `-- shared Grafana instance / LaundryGo organization
    |
    `--> jenkins.laundrygo.duckdns.org
           `-- dedicated Jenkins VM and Authentik OIDC

LaundryGo API on VM 117
    |-- metrics listener :9464 (private, Prometheus scrape only)
    |-- structured logs -> Alloy -> Loki
    `-- OTLP/HTTP :4318 -> OpenTelemetry Collector -> Tempo

Monitoring LXC
    |-- Grafana (shared UI)
    |-- Prometheus (shared metrics storage)
    |-- Loki (shared log storage)
    |-- Tempo (traces)
    `-- OpenTelemetry Collector (private OTLP receiver)
```

All traffic between LaundryGo, the monitoring LXC, and Jenkins uses the
private PVE network. Caddy is the only intended public ingress. Loki, Tempo,
the OpenTelemetry Collector, and Prometheus do not gain public routes.

## 4. Identity and Authorization

### 4.1 Authentik

Create the `laundrygo-members` group in the existing Authentik configuration.
Administrators add named users to that group. Existing `authentik Admins`
retain their administrative capabilities.

Create one Authentik OIDC application for Jenkins. It emits `openid`,
`profile`, `email`, and `groups` claims. Its access policy permits
`laundrygo-members` and `authentik Admins` only. Jenkins validates its own
OIDC session; Caddy only terminates TLS and proxies the public request.

The existing Grafana Generic OAuth provider is extended, not replaced. It uses
the Authentik `groups` claim as the explicit organization mapping input. It
does not rely on Grafana Team Sync. The live Main organization name and current
administrator mapping are recorded during pre-flight before these mappings are
applied:

| External group | Grafana organization | Role |
| --- | --- | --- |
| `laundrygo-members` | `LaundryGo` | Viewer |
| `authentik Admins` | Main organization and `LaundryGo` | Admin |

The configuration rejects a user whose group claim does not match an explicit
mapping. It must not place LaundryGo members in the Main organization as a
fallback, and it must preserve the existing administrator path.

### 4.2 Grafana resources

Create the `LaundryGo` Grafana organization and a top-level `LaundryGo`
folder. Add only LaundryGo dashboards and project-specific datasource entries
to that organization. The Main organization and its homelab dashboards remain
unchanged.

The member role is Viewer. It can read the LaundryGo folder and dashboards but
cannot edit dashboards, alter datasource definitions, manage alerts, change
organization settings, or enter Jenkins administration.

This is a Grafana UI/resource boundary. Because the underlying Prometheus and
Loki servers remain shared, it is not a security boundary suitable for
untrusted tenants. Project members are deliberately trusted within the
homelab's shared observability environment.

The initial rollout does not depend on per-organization Explore restrictions,
because the installed Grafana OSS edition does not make that a hard backend
boundary. Members are trusted users with dashboard-resource access only; the
acceptance test verifies organization and dashboard permissions, while the
shared-backend limitation remains explicit. A future requirement for untrusted
members requires separate telemetry stores or a query-enforcing proxy.

### 4.3 Jenkins authorization

Jenkins maps the same Authentik group claim to two roles:

| Group | Jenkins permissions |
| --- | --- |
| `laundrygo-members` | Read jobs and build history; trigger approved CI jobs; read console output and artifacts |
| `authentik Admins` | Full controller administration |

Members cannot configure jobs, modify credentials, manage plugins, administer
nodes, approve deployments, or access controller secrets. CI console output
must redact credential values and must never print environment files.

## 5. Observability Data Model

### 5.1 Signal separation

The observability stack records service behavior. It does not replace the
application telemetry data model.

- **Application telemetry:** normalized, traceable LaundryGo events belong in
  the application data store after the MQTT ingestion feature is implemented
  and the register map semantics are verified.
- **Metrics:** bounded-cardinality counters, gauges, and histograms exposed by
  the API and scraped by Prometheus.
- **Logs:** structured operational records sent to Loki.
- **Traces:** request and pipeline spans exported to Tempo through OTLP.

Every new signal uses stable service attributes including
`service.name=laundrygo-api`, `deployment.environment`, and
`project=laundrygo`.

When real ingestion is implemented, the application data path preserves the
required `branch_id`, `machine_id`, `register_map_version`, `event_timestamp`,
and `received_at` fields. An invalid payload is quarantined in application
storage with its validation reason. Observability records only a safe event
hash, schema version, rejection reason, and correlation ID; it never receives
the raw payload.

### 5.2 Metric and log rules

Metrics must not use `machine_id`, event ID, request ID, phone number, or raw
branch name as labels. High-cardinality identifiers belong in traces or
structured logs only. Prometheus metrics include, at minimum:

- API request count, duration, and error count.
- Telemetry event accepted and rejected counts, grouped only by stable reason
  and schema version.
- Telemetry event processing latency.
- Last successful ingestion time and last successful dashboard update time.

Logs record validation outcomes, correlation IDs, timestamp skew, rule version,
and safe operational context. They do not include raw MQTT payloads, customer
PII, access tokens, database URLs, or provider secrets.

### 5.3 Trace and dashboard behavior

The API creates traces for request handling and, once ingestion exists,
normalization, idempotency, persistence, and alert evaluation. A trace carries
safe correlation identifiers but not raw device payloads.

The initial LaundryGo dashboards are:

1. **Service overview** — availability, API latency, errors, and deployment
   version.
2. **Telemetry pipeline** — accepted/rejected events, reasons, processing
   latency, and freshness.
3. **Logs and traces** — filtered operational logs and linked traces for
   incident triage.

All dashboard queries filter on `project=laundrygo`. The telemetry dashboard
is empty or explicitly reports unavailable data until a real, validated
telemetry pipeline exists; it must never fabricate telemetry.

While `LAUNDRYGO_DEMO_MODE=true`, the service overview explicitly displays
demo/reporting-source state. Telemetry freshness, rejection, and stale-data
panels remain unavailable rather than showing zero-valued production metrics.

## 6. Infrastructure Components

### 6.1 Monitoring LXC changes

The existing monitoring LXC gains:

- Tempo with local persistent storage and a declared retention period.
- An OpenTelemetry Collector bound only to the private network.
- Grafana datasource provisioning for Tempo and LaundryGo-specific Prometheus
  and Loki entries.
- Grafana organization, folder, datasource, and dashboard provisioning or a
  repeatable administrative script.

Before enabling Tempo, increase the monitoring LXC resources after measuring
current usage. The target is at least 3 GiB RAM and 24 GiB root storage, with
the final values verified against PVE capacity. Retention starts conservatively
and is reviewed after one week of real service data. The initial policy is:

| Store | Initial retention | Capacity control |
| --- | --- | --- |
| Prometheus | Existing 30 days | Preserve the existing retention and alert on LXC disk pressure |
| Loki | Existing 14 days | Preserve the existing retention and alert on LXC disk pressure |
| Tempo | 7 days | Review storage after one week; alert when monitor LXC disk use exceeds 80% |

Before adding any new image, record the running Grafana, Loki, and Prometheus
digests. New Tempo, Collector, Alloy, and Jenkins images use tested immutable
tags or digests. Updating pre-existing `latest` images is a separate reviewed
maintenance change, not an incidental part of LaundryGo delivery.

### 6.2 LaundryGo VM changes

VM 117 gains only the observability components necessary for the application:

- API instrumentation and a dedicated metrics listener on private port `9464`.
  The public Nginx route and Caddy route do not proxy this port or a `/metrics`
  path.
- A minimal Alloy log agent with a read-only Docker socket and only the mounts
  needed to collect LaundryGo container logs.
- OTLP/HTTP export to the private collector on port `4318`.

The API remains read-only. Metrics and traces describe the reporting service;
they do not authorize telemetry ingestion, machine control, payment writes, or
access to upstream IRIS credentials.

### 6.3 Jenkins workload

Provision a dedicated Jenkins VM on `local-lvm`, selecting a free VM ID during
the live pre-flight. Initial sizing is 2 vCPU, 4 GiB RAM, and 32 GiB disk. The
VM runs the Jenkins controller and a Node.js 22 build environment. It does not
receive direct production database access, machine credentials, or unrestricted
SSH access to VM 117.

The first pipeline checks out the canonical repository and runs:

```text
pnpm test
pnpm check
pnpm build
docker compose -f compose.ci.yaml build
```

`compose.ci.yaml` is a build-only file that never reads the production `.env`
file, database, or provider credentials. It supplies only non-secret build
arguments and verifies both application images from a clean workspace. The
final Docker build is a verification artifact only. Deployment remains a
human-approved process with a separate future design.

Jenkins configuration uses Configuration as Code. The OIDC client secret stays
in a mode-restricted runtime secret file outside Git. Jenkins home and the
controller guest are included in the PVE backup schedule; the restore test
uses an isolated guest identity. Job artifacts expire after 14 days unless a
release administrator explicitly retains one.

### 6.4 Public routing

| Endpoint | Exposure | Authentication |
| --- | --- | --- |
| `grafana.notnotik.duckdns.org` | Existing public Grafana route | Existing Authentik Generic OAuth, extended with LaundryGo organization mapping |
| `jenkins.laundrygo.duckdns.org` | New public Caddy route | Jenkins Authentik OIDC |
| Prometheus, Loki, Tempo, OTLP | Private PVE network only | Network firewall and service-level configuration |

The Jenkins route receives an individual public certificate through Caddy. No
wildcard certificate or public wildcard catch-all route is required. Caddy
terminates public TLS and proxies only to Jenkins's private HTTP listener;
end-to-end upstream TLS is not implied by this design.

## 7. Firewall and Network Rules

All network changes are deny-by-default additions to the persistent PVE guard:

- Pi Caddy may reach only the Jenkins private HTTP listener.
- The monitoring LXC may reach VM 117 port `9464` only.
- VM 117 may reach the monitoring LXC port `3100` for Loki ingestion and port
  `4318` for OTLP/HTTP only.
- No direct internet or LAN route is added to the monitoring write APIs.

Each rule is added before the applicable source-deny rule and covered by the
existing firewall regression test. The actual source address, destination port,
and service listener are discovered during pre-flight rather than inferred from
old DHCP data.

## 8. Delivery Sequence

1. **Capacity gate:** inventory PVE `local` storage, propose exact recovery
   targets, obtain approval, and verify at least 10 GiB free. Confirm PVE
   memory, `local-lvm`, stable private addresses, VM ID, service health, and
   firewall state.
2. **Identity gate:** back up the current Grafana configuration, create the
   Authentik group and Jenkins OIDC application, create the Grafana
   `LaundryGo` organization, and validate an administrator and a member test
   account. This includes the Grafana TLS/root URL and break-glass pre-flight
   checks.
3. **Observability:** expand the monitor LXC as needed, add Tempo and the
   collector, add private firewall rules, then provision LaundryGo metrics,
   logs, traces, datasources, and dashboards.
4. **Jenkins:** provision the dedicated VM, configure OIDC and authorization,
   add the Caddy route and firewall rule, then create the verification-only
   pipeline.
5. **Acceptance and rollback check:** execute access, network, data hygiene,
   alerting, backup/restore, and CI verification. Record deployed versions and
   rollback locations.

The steps are intentionally ordered so no public route is created before its
authorization policy, internal service, and firewall rules are verified.

## 9. Verification and Acceptance Criteria

### 9.1 Identity and access

- A `laundrygo-members` user can sign in to Grafana and lands in the
  `LaundryGo` organization.
- That user cannot access a Main organization dashboard URL, edit a LaundryGo
  dashboard, alter a datasource, or access Grafana administration.
- An `authentik Admins` user retains access to both Grafana organizations.
- A LaundryGo member can read and trigger the approved Jenkins CI job but
  receives authorization denial for job configuration, credentials, controller
  administration, and deployment actions.

### 9.2 Observability

- A controlled API request appears as a Prometheus metric, structured Loki log,
  and Tempo trace with `project=laundrygo`.
- Dashboard queries show only explicitly labeled LaundryGo signals.
- A synthetic invalid telemetry sample, when the ingestion feature exists,
  increments the safe rejection metric and never exposes its raw payload.
- Loki, Tempo, Prometheus, and OTLP are unreachable from the public internet.
- Alertmanager produces a tested alert for API target down, scrape failure,
  Collector or Tempo unavailability, and monitor LXC disk pressure. A
  telemetry-stale alert is enabled only after real ingestion is available.
  These alerts use the existing default Alertmanager receiver; adding a new
  recipient or LINE delivery is a separate approved change.
- A backup restore test validates the new Jenkins guest and confirms that
  Grafana's LaundryGo organization resources can be recreated from their
  declared configuration.

### 9.3 CI and public routing

- Jenkins is available through HTTPS at
  `jenkins.laundrygo.duckdns.org`, redirects unauthenticated users to
  Authentik, and denies users outside the allowed groups.
- The CI job completes `pnpm test`, `pnpm check`, `pnpm build`, and Docker
  build verification from a clean workspace.
- A successful job does not deploy to VM 117.
- Caddy configuration validation, firewall regression tests, container health,
  and external HTTPS smoke tests all pass.
- The CI build succeeds without a production `.env` file, upstream credentials,
  or access to VM 117.

## 10. Rollback

- Restore the previous Grafana OAuth configuration and remove the LaundryGo
  organization mapping. The documented local Grafana break-glass login remains
  available if OAuth mapping fails.
- Remove the Caddy Jenkins route only after the controller is made private or
  stopped; restore the validated previous Caddy configuration first.
- Remove only the new, named firewall rules and restore the prior persistent
  firewall script if the rule test or connectivity check fails.
- Stop the new Tempo, collector, log agent, or Jenkins services without
  touching existing Grafana, Loki, Prometheus, or LaundryGo application data.
- Keep the existing VM 117 rollback snapshot and application data intact.
- Restore the previous monitoring LXC sizing only after Tempo data has been
  intentionally discarded or archived according to the approved retention
  policy.

## 11. Out of Scope

- Production machine commands, payment writes, or remote device control.
- New sensors, hardware changes, rewiring, or safety detection.
- A claim that pressure alone detects a gas leak.
- Automatic production deployment, secret distribution, or a public telemetry
  API.
- Hard multi-tenant storage isolation for shared Prometheus and Loki.
- Mimir, object storage, and long-term metrics clustering.
