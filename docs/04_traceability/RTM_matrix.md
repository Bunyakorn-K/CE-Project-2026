# 🔗 Requirements Traceability Matrix (RTM)

**Document Purpose:** This matrix ensures that every developed system function (F) directly satisfies a quantifiable requirement (R) and originates from a specific user story (US). It prevents "scope creep" and ensures all business needs are technically addressed.

| Domain / Feature                  | User Story (US) | Requirement (R) | System Function (F)                        | Phase     |
| :-------------------------------- | :-------------- | :-------------- | :----------------------------------------- | :-------- |
| **MQTT Ingestion & Reliability**  | US-10           | R01, R02        | F-04 (Streaming), F-05 (Data Pipeline)     | **MVP**   |
| **RBAC & Multi-Tenant Security**  | US-09, US-11    | R04             | F-06 (RBAC), F-07 (Audit Log)              | **MVP**   |
| **Digital Twin (Machine Status)** | US-02           | R02, R04        | F-01 (State Sync)                          | **MVP**   |
| **Business Dashboard (Revenue)**  | US-04           | R03, R04        | F-08 (KPI Aggregation)                     | **MVP**   |
| **Gas Early-Warning System**      | US-01           | R05, R06        | F-02 (Gas Remaining), F-10 (Alert Engine)  | **MVP**   |
| **Coin-Box Estimation**           | US-03           | R05, R07        | F-09 (Coin-Box Logic), F-10 (Alert Engine) | **MVP**   |
| **AI Executive Summary**          | US-05           | R04, R08        | F-11 (Safe Function Calling)               | **MVP**   |
| **Rule-Based Maintenance Alert**  | US-08           | R05, R10        | F-10 (Alert Engine)                        | **MVP**   |
| **AI Smart Promotion**            | US-06           | R09             | _Pending AI Model Design_                  | _Phase 2_ |
| **Spatial Anomaly Diagnostics**   | US-08           | R10             | F-03 (Spatial Layout)                      | _Phase 2_ |
| **Customer Web View**             | US-07           | R11             | F-13 (Public API)                          | _Phase 2_ |
| **Weather Demand Analysis**       | US-06           | R12             | F-12 (External Context)                    | _Phase 2_ |

---

### 📌 How to maintain this document:

- **Developers:** Before building a new feature, find its `F-ID` here. Ensure your code satisfies the linked `R-ID` criteria.
- **Testers (QA):** Use this matrix to write test cases. A test case for `US-01` must explicitly test the logic in `F-02` and `F-10`.
