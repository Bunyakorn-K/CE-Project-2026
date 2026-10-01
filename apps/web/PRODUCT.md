# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

LaundryTwin primarily serves a role-based operations team for commercial laundromat franchises:

- **Owners** monitor authorized branches, review business performance, administer AI settings, and request scoped executive analysis.
- **Branch managers** monitor assigned branches, investigate operational exceptions, and act on alerts without access to unauthorized revenue or machine data.
- **Technicians** inspect machine evidence and alerts for assigned branches without receiving revenue access.

Marketers and laundromat customers are future audiences for off-peak recommendations and public machine availability. Those experiences are not part of the current primary workflow.

## Product Purpose

LaundryTwin turns data from existing commercial-laundry equipment and local systems into a multi-branch Digital Twin, traceable operational analytics, evidence-backed alerts, and safe AI-assisted analysis. It exists so franchise teams can understand branch and machine conditions without replacing existing hardware, fabricating unavailable state, or exposing data outside a user's authorized scope.

Success means an authorized user can move from a business overview or alert to branch, machine, time, and source evidence; make an informed operational decision; and understand data freshness and limitations. The repository implementation is a starting point and does not yet satisfy every target requirement.

## Positioning

LaundryTwin combines existing laundry telemetry and business records with server-enforced branch scope, visible data provenance, and allow-listed analytics functions. Its defining mechanism is an evidence chain from authorized operational data to Digital Twin state, KPIs, alerts, and AI-assisted answers, without giving an AI model arbitrary data access or presenting cloud estimates as physical safety systems.

## Operating Context

- The product is used through a mobile-first LINE LIFF interface and a responsive desktop browser interface.
- Users sign in through LINE, email, or an explicitly enabled demo session, then use grants to determine branch scope and role.
- Owners review multi-branch performance, managers work within assigned branches, and technicians work without revenue access.
- Core workflows include dashboard review, branch-specific machine inspection, executive summaries, alert review, off-peak analysis, AI configuration, and internal health or API diagnostics.
- The current reporting path combines optional read-only IRIS integration with direct ClickHouse analytics. Batch ETL moves normalized usage, temperature, and weather data into ClickHouse; Superset and Airflow support operational analytics workflows.
- Machine data may be delayed, stale, incomplete, or unavailable. Operators need source, freshness, demo, unknown, stale, and unavailable states to remain visible.
- The product is evaluated as operational software under real branch conditions, not only as a prototype or marketing demonstration.
- Production runs as one deployment on a single VM with no staging tier, so a change is verified in place against a named rollback image rather than promoted from a lower environment. The analytics warehouse has no automated backup; a recoverable copy is taken by hand before a specific change, which makes backup a deliberate step in any release rather than an assumed one.
- Access is delivered through LINE: the LINE bot pushes notifications, and MCP serves six allow-listed analytics functions (`get_revenue_daily`, `get_cycles_daily`, `get_utilization_heatmap`, `get_temperature_curve`, `get_weather_usage_correlation`, `get_off_peak_windows`) to external tools. Both carry the same scope and redaction rules as the interface.

## Capabilities and Constraints

Current confirmed capabilities include:

- Revenue, cycle, utilization, branch, machine, and executive-summary reporting.
- A Digital Twin view for known machine state, remaining time, temperature, and data freshness when those fields are supported by verified evidence.
- Role-based access grants for owners, managers, and technicians, with branch scope and revenue permissions enforced by the server.
- Allow-listed MCP analytics and an AI console that cannot execute arbitrary model-generated SQL.
- An owner-only diagnostics playground that reports system health and runs allow-listed analytics checks.
- Local alert acknowledgement, AI settings, access grants, sessions, and audit-related workflows.
- Explicitly labeled demo mode for intentional local or stakeholder demonstrations.

Durable constraints and boundaries:

- Use existing equipment and verified register or telemetry meanings; do not add sensors, rewire machines, or invent hardware semantics without an explicit scope change.
- The browser must never receive upstream service credentials.
- The current application must not send machine commands, write payment data, or automatically fall back to demo data when real data is unavailable.
- Pressure trends may support a low-gas estimate only when evaluated with supported machine state and temperature. Pressure alone is not gas-leak detection, and cloud estimates are not a replacement for local life-safety alarms.
- Unknown or unresolved fields such as `paid` semantics, coin-box resets, register meanings, units, and model-specific mappings must remain explicit until verified.
- Money remains integer satang through application logic and is formatted only for presentation.
- LINE authentication is verified end to end in the real client (2026-10-01). Direct ClickHouse report scope, revenue redaction, and strict date validation still require production verification; they must not be described as completed security guarantees. Per-branch scoping paths remain covered by unit tests rather than by a production account holding a narrower grant.

Data constraints that bound what the product can honestly claim:

- Machine-event telemetry is not yet ingested. The event feed reports its source as present-but-unwritten with a stated reason, never as an empty list — an empty list would read as "no events in this window", which the warehouse cannot support. Absent, present-but-unwritten, and present-with-data are three distinct states and must never render the same.
- A majority of real usage rows carry no `machine_session_id`, so a cycle count must never be presented as fully attributed; the unattributed share is stated in Thai.
- Usage volume is short of the three months needed for the seasonal and gradient-boosting model candidates, so only the percentile baseline is supported today.
- A missing day in a usage series is a genuine source gap, not a zero, and must not be silently filled.
- Gas-pressure readings are an additive source that feeds no KPI, no Digital Twin state, and no alert.

## Brand Commitments

- **LaundryTwin** is the canonical product name.
- The current identity uses a typographic `LT` mark and an operations-workspace context; no standalone logo asset is established in the repository.
- Product language is Thai-first. English remains appropriate for established technical terms such as Digital Twin, ClickHouse, MCP, API, and model names.
- Product copy must remain operational, direct, and explicit about evidence, permissions, and uncertainty.
- **A server-supplied reason must not reach a Thai-first page untranslated.** Rendering an English freshness or availability reason verbatim under a Thai heading was a real defect; presentation state belongs in the view layer, keyed on a stable contract field rather than on matching English prose, so rewording the server string cannot silently break the check.
- **The privacy policy and terms pages stay readable without signing in.** They are legal documents governing user data, not product surface; gating them would put a pending-access card where a LINE reviewer expects the policy.
- Emoji must not serve as primary navigation or KPI iconography.

## Evidence on Hand

- Product and current implementation overview: `README.md`
- Repository authority, product boundaries, and verification status: `AGENTS.md`
- Requirements: `docs/01_requirements/system_requirement.md`, `docs/01_requirements/user_stories.md`, and `docs/01_requirements/system_functions.md`
- Current web routes and user-facing language: `apps/web/src/routes/`
- Current interface tokens and responsive behavior: `apps/web/src/styles.css`
- Current optional IRIS contract: `docs/integration/iris-laundrytwin-read-api.md`
- ML feature and evidence limits: `docs/06_ml/ml-training-data-guide.md`
- Production deployment topology, verification, and rollback targets: `docs/02_architecture/deploy-runbook.md`
- Allow-listed analytics functions: `apps/api/src/analytics/mcp.ts`
- Thai-first presentation state mapping: `apps/web/src/lib/machine-status.ts`, `apps/web/src/lib/alerts-view.ts`

No customer testimonial, documented case study, adoption benchmark, or independent product-research corpus has been established. Future work must not fabricate these forms of proof.

## Product Principles

1. **Authorized scope is part of every answer.** Branch access and revenue permissions are enforced server-side, not inferred from what the interface chooses to display.
2. **Evidence before confidence.** Every operational conclusion should preserve its source, time range, freshness, assumptions, and unresolved semantics.
3. **Unknown state stays visible.** Missing, stale, offline, unavailable, and unknown data must not be replaced with simulated or inferred production values.
4. **One operations system across contexts.** Mobile LINE LIFF and desktop browser views serve the same product truth with task-appropriate density and interaction.
5. **AI assists, it does not bypass controls.** AI features operate through allow-listed functions, inherit server-enforced scope, and preserve auditability.
6. **Existing infrastructure remains an asset.** LaundryTwin derives value from deployed laundry systems without assuming permission to change hardware or physical safety equipment.
7. **Decoration must not assert what the text disclaims.** A picture that encodes a machine state is a claim, and it is held to the same standard as the words beside it. The Digital Twin cards used to carry a 116×96px drum illustration whose two bits of information — running or not, washer or dryer — were already stated in the status and kind pills, and which read `status` alone, so a machine whose freshness was `unavailable` was drawn with the same live wave as a fresh one. It was removed. An illustration earns its place by carrying a fact the text does not, not by occupying the largest region of a card.

## Accessibility & Inclusion

Thai is the primary interface language, and technical terms may remain in English when that improves recognition. The product must remain usable across mobile LINE LIFF and desktop browser contexts, and status must never be communicated by color alone. No formal accessibility conformance target has been confirmed yet.
