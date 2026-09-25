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

## Capabilities and Constraints

Current confirmed capabilities include:

- Revenue, cycle, utilization, branch, machine, and executive-summary reporting.
- A Digital Twin view for known machine state, remaining time, temperature, and data freshness when those fields are supported by verified evidence.
- Role-based access grants for owners, managers, and technicians, with branch scope and revenue permissions enforced by the server.
- Allow-listed MCP analytics and an AI console that cannot execute arbitrary model-generated SQL.
- Local alert acknowledgement, AI settings, access grants, sessions, and audit-related workflows.
- Explicitly labeled demo mode for intentional local or stakeholder demonstrations.

Durable constraints and boundaries:

- Use existing equipment and verified register or telemetry meanings; do not add sensors, rewire machines, or invent hardware semantics without an explicit scope change.
- The browser must never receive upstream service credentials.
- The current application must not send machine commands, write payment data, or automatically fall back to demo data when real data is unavailable.
- Pressure trends may support a low-gas estimate only when evaluated with supported machine state and temperature. Pressure alone is not gas-leak detection, and cloud estimates are not a replacement for local life-safety alarms.
- Unknown or unresolved fields such as `paid` semantics, coin-box resets, register meanings, units, and model-specific mappings must remain explicit until verified.
- Money remains integer satang through application logic and is formatted only for presentation.
- Direct ClickHouse report scope, revenue redaction, strict date validation, and LINE authentication still require production verification; they must not be described as completed security guarantees.

## Brand Commitments

- **LaundryTwin** is the canonical product name.
- The current identity uses a typographic `LT` mark and an operations-workspace context; no standalone logo asset is established in the repository.
- Product language is Thai-first. English remains appropriate for established technical terms such as Digital Twin, ClickHouse, MCP, API, and model names.
- Product copy must remain operational, direct, and explicit about evidence, permissions, and uncertainty.
- Emoji must not serve as primary navigation or KPI iconography.

## Evidence on Hand

- Product and current implementation overview: `README.md`
- Repository authority, product boundaries, and verification status: `AGENTS.md`
- Requirements: `docs/01_requirements/system_requirement.md`, `docs/01_requirements/user_stories.md`, and `docs/01_requirements/system_functions.md`
- Current web routes and user-facing language: `apps/web/src/routes/`
- Current interface tokens and responsive behavior: `apps/web/src/styles.css`
- Current optional IRIS contract: `docs/integration/iris-laundrytwin-read-api.md`
- ML feature and evidence limits: `docs/06_ml/ml-training-data-guide.md`

No customer testimonial, documented case study, adoption benchmark, or independent product-research corpus has been established. Future work must not fabricate these forms of proof.

## Product Principles

1. **Authorized scope is part of every answer.** Branch access and revenue permissions are enforced server-side, not inferred from what the interface chooses to display.
2. **Evidence before confidence.** Every operational conclusion should preserve its source, time range, freshness, assumptions, and unresolved semantics.
3. **Unknown state stays visible.** Missing, stale, offline, unavailable, and unknown data must not be replaced with simulated or inferred production values.
4. **One operations system across contexts.** Mobile LINE LIFF and desktop browser views serve the same product truth with task-appropriate density and interaction.
5. **AI assists, it does not bypass controls.** AI features operate through allow-listed functions, inherit server-enforced scope, and preserve auditability.
6. **Existing infrastructure remains an asset.** LaundryTwin derives value from deployed laundry systems without assuming permission to change hardware or physical safety equipment.

## Accessibility & Inclusion

Thai is the primary interface language, and technical terms may remain in English when that improves recognition. The product must remain usable across mobile LINE LIFF and desktop browser contexts, and status must never be communicated by color alone. No formal accessibility conformance target has been confirmed yet.
