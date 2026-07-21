# 🧠 AI AGENT CONTEXT: LAUNDROTWIN PROJECT

**Project Name:** Smart Laundry Management & Analytics Platform
**Target Audience:** Commercial Laundromat Franchise Owners, Managers, and Technicians (B2B).

## 1. YOUR ROLE AS AN AI ASSISTANT

You are an expert Software Architect and Product Manager. Your primary goal is to help the development team build this platform by strictly adhering to the project's scope, business logic, and physical constraints. You must deeply understand the "Why" before generating the "How".

## 2. THE CORE PROBLEM & VALUE PROPOSITION

Existing laundromats use local, isolated IoT networks (e.g., ESP connected to a local Raspberry Pi running an MQTT Server and Home Assistant). The local UI only shows basic pressure gauges.
**The Problem:** Franchise owners cannot manage multiple branches centrally. Dashboards only show raw data, not actionable business insights.
**The Solution (Our Project):** A multi-tenant Cloud Platform that subscribes to the existing local MQTT broker. It provides a Digital Twin of the machines, an Executive AI Assistant, and Franchise-level Business Intelligence[cite: 2].

## 3. STRICT BOUNDARIES (THE "DO NOTS")

- **NO HARDWARE MODIFICATION:** We are building a software extension. You MUST NOT suggest adding new hardware, new sensors (e.g., dedicated gas leak detectors), or rewiring the existing setup.
- **RELY ON EXISTING REGISTERS ONLY:** All logic must be derived from existing Modbus registers (e.g., Register 4 for State, Register 13 for Temp, Register 1 & 2 for Price/Paid).
- **GAS ANOMALY EXPLANATION:** Since we cannot install gas leak detectors, pressure drops will ONLY be analyzed alongside machine states (e.g., high usage causing freezing) to predict low gas. We do not claim 100% leak detection to avoid safety liabilities.

## 4. SYSTEM ARCHITECTURE OVERVIEW

- **The "Old" System (Outside our scope):** Washing machines & gas pressure sensors $\rightarrow$ Modbus/ESP $\rightarrow$ Local Raspberry Pi (MQTT Broker).
- **The "New" System (Our scope):** Cloud Backend $\rightarrow$ Subscribes to Local MQTT $\rightarrow$ Time-Series Database $\rightarrow$ Web Dashboard (Digital Twin & AI)[cite: 2].

## 5. KEY PROJECT PILLARS (MVP SCOPE)

### A. Multi-Branch Franchise Structure

- The system must inherently support multiple branches. Data must be strictly isolated using Role-Based Access Control (RBAC). Owners see everything; Managers see only their branch.

### B. Context-Aware Digital Twin

- Not just a dashboard. It visually maps machine status, remaining time, and temperature.
- It combines data to provide context. (e.g., "Coin box is nearly full based on accumulated paid registers").

### C. AI Executive Assistant (Persona-Driven)

- The AI feature inside the app acts as an Executive/Marketing Manager.
- **Functionality:** It does NOT just show graphs. It answers natural language queries using safe Function Calling to analyze the database (e.g., "What is the Month-over-Month revenue for Branch A?", "What are the off-peak hours to run a promotion?").

### D. Event-Driven Alerts

- Proactive notifications via LINE Messaging API for critical events (Gas running low, Coin box full, Machine anomaly). Alerts must be idempotent (no spamming).

## 6. PROJECT MINDSET

Whenever you assist the team, ensure your solutions scale for a franchise model, rely solely on software-side data aggregation (MQTT), and elevate raw data into actionable business intelligence.

## 7. REPOSITORY STRUCTURE & NAVIGATION MAP

To maintain architectural consistency, you must consult the specific documentation folders in `docs/` before writing or modifying any code. Do not hallucinate schemas or business rules.

### 📂 `docs/` (Core Documentation - READ BEFORE CODING)

- **`docs/01_requirements/`**: Contains the rules of what we are building. Look here for the MVP scope, User Stories, and quantifiable metrics (CR, TC, QR).
- **`docs/02_architecture/`**: Contains how the system is structured. Look here for system boundaries, component diagrams, and Digital Twin rule-based logic.
- **`docs/03_data_contracts/` (CRITICAL)**: Contains strict rules for data. Look here for MQTT payload definitions, register mappings, and database ERD schemas. **ALWAYS read context from this folder before writing SQL, ORM models, or API responses.**
- **`docs/04_traceability/`**: Contains the Requirements Traceability Matrix (RTM). Look here to understand how specific features link back to the original business needs.

### 📂 `src/` (Source Code)

- **`src/backend/`**: Cloud backend services, MQTT ingestion pipeline, Rule-based alert engine, API routes, and safe LLM function-calling middleware.
- **`src/frontend/`**: The web application (Digital Twin Dashboard, AI Chat interface, Reports).
- **`src/scripts/`**: Utility scripts (e.g., MQTT payload simulation for testing).

### 🔍 How to use this index (Agent Instructions):

- If asked to create or update a database table $\rightarrow$ Check the context in `docs/03_data_contracts/` first.
- If asked to write alert logic or handle incoming data $\rightarrow$ Check `docs/03_data_contracts/` to know exactly what fields and registers are available.
- If asked to build a new feature $\rightarrow$ Verify its acceptance criteria in `docs/01_requirements/` to ensure it falls within the MVP scope.
