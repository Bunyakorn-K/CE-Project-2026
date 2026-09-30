# Ops forensics — `analytics-postgres-1` cluster reinitializations (2026-09-30)

**Question asked:** why does Airflow restart, and what causes it?

**Status: the Airflow restart is fully explained. The underlying Postgres fault
is characterised but its trigger is NOT identified, and cannot be from the
retained evidence.** This document records what is proven, what is ruled out,
and the one configuration change that would make the next occurrence
diagnosable. It is deliberately not a "resolved" record.

---

## 1. What is proven: the Airflow restart chain

Airflow's scheduler and triggerer do not restart on their own. The sequence is:

1. A Postgres **backend** process dies abnormally.
2. The postmaster treats any backend death as possible shared-memory
   corruption and does the only safe thing: terminate every other backend and
   **reinitialize the whole cluster** (~20–30 s, all connections refused).
3. Every Airflow connection breaks at once. psycopg2 raises
   `OperationalError: server closed the connection unexpectedly / This
   probably means the server terminated abnormally`, seen in both
   `scheduler_job_runner.py` (heartbeat commit) and `triggerer_job_runner.py`.
4. Airflow exits, and `restart: unless-stopped` (verified on the container)
   brings it back.

The connection-refusal storm is visible in the Postgres log as ~15
`FATAL: the database system is in recovery mode` lines in the same second the
postmaster reinitializes. That is the fingerprint, and it is what the earlier
investigation called an unexplained restart.

**The Airflow restart is a symptom. The fault is in Postgres.**

## 2. The fault, measured

`grep -c "all server processes terminated; reinitializing"` over the container's
retained log: **59 cluster reinitializations since 2026-09-06 20:01:21**, the
last at **2026-09-30 10:55:47**.

The container's log begins at 2026-09-06T18:22:49, so this is the full retained
history — not a truncated tail. `RestartCount=0` on the container, and
`pg_postmaster_start_time()` is 2026-09-22 05:49:30, i.e. the postmaster has
been up continuously for 8 days across the 09-30 crash. These are in-place
crash-restarts, not container restarts.

Each backend death carries an explicit cause. This is the correction to the
earlier claim that the logs were detail-free — they are not:

| Cause line | Count |
|---|---|
| `server process (PID N) exited with exit code 2` | 39 |
| `server process (PID N) was terminated by signal 13: Broken pipe` | 16 |

Per day (crashes vs. host OOM kills, same table):

| Date | PG reinitializations | Host OOM kills |
|---|---|---|
| 2026-09-06 | 1 | 0 |
| 2026-09-10 | 1 | 0 |
| 2026-09-13 | 2 | 1 |
| 2026-09-14 | 20 | 10 |
| 2026-09-15 | 11 | 4 |
| 2026-09-16 | 18 | 7 |
| 2026-09-18 | 4 | 0 |
| 2026-09-22 | 1 | 0 |
| 2026-09-30 | 1 | 0 |

The burst is 2026-09-13 → 09-18: **55 of 59 crashes in six days**, and that is
exactly when Airflow's Postgres landed (2026-09-13). The rate then collapses to
roughly one per several days. Whatever was driving it was tied to that
deployment window and has since largely stopped.

## 3. Ruled out by measurement

**Not OOM.** The host did come under global memory pressure — 22 `oom-kill`
events since 2026-09-01 — but:

- **Postgres was never the victim.** The authoritative `oom-kill: task=` field
  names only `clickhouse-serv` (16), `systemd` (2), `MainThread` (2),
  `(sd-pam)` (2). No postgres or airflow process was ever killed. The Postgres
  container's own cgroup counters are all zero (`oom_kill 0`).
- **Timing does not line up.** Widening the window to ±30 min puts 40 of 59
  crashes near an OOM, which looks convincing and is still not causation: the
  final crash is **2026-09-30 10:55:47, 13.8 days after the last OOM
  (2026-09-16 21:55:49)**, with no memory pressure at all. Same for 09-06,
  09-10, 09-22. The OOM activity was a co-timed symptom of the same
  under-resourced period, not the trigger. Host and container clocks were both
  verified `Etc/UTC` before drawing this conclusion.
- **Postgres appears as a memory *consumer*, not a victim** — `postgres invoked
  oom-killer` twice, meaning a backend's allocation tipped the host over. It
  contributed to the pressure; it was not killed by it.

**Not an OOM of the container, not a crash of the container.** `OOMKilled=false`,
`RestartCount=0`, `ExitCode=0`.

**Not `apt-daily`.** Timers ran at 11:01 on 09-30; the crash was 10:55.

**Not ClickHouse.** `analytics-clickhouse-1` logged **zero** lines in the
10:50–11:05 window around the 09-30 crash.

**Not an unattended host reboot.** The single 09-22 event follows a manual
`dockerd` "Loading containers: start" (host/daemon restart), and `uptime`
reports 8 days — so it is not a recurring reboot pattern.

## 4. What the two signatures mean

**`signal 13: Broken pipe` (16×).** SIGPIPE on a backend means the process was
writing to a socket whose client had already gone away. In two captured cases
the backend's own last words are logged immediately before the crash:

```
LOG:  could not send data to client: Broken pipe
FATAL:  connection to client lost
```

So a client disconnected mid-result-set and the backend died on the write. A
backend dying this way is unusual — Postgres normally survives a vanished
client — and it is the signature most consistent with a client being torn down
abruptly (killed, or its container stopped) while a query was streaming.

**`exited with exit code 2` (39×, the majority).** A backend exiting with code
2 is not a signal and not an OOM. No `PANIC`, no `ERROR`, and no FATAL other
than the recovery-mode storm appears anywhere in the retained log attributable
to the dying backend. **The evidence needed to name this one was never
recorded.**

## 5. Why the trigger cannot be recovered, and the one fix

The blocker is a logging configuration, not missing forensics effort:

| Setting | Value | Consequence |
|---|---|---|
| `log_connections` | **off** | no record of which client connected |
| `log_disconnections` | **off** | no record of which client vanished |
| `log_min_messages` | `warning` | the dying backend's own last error is suppressed |
| `log_line_prefix` | `%m [%p]` | **no `application_name`, no client host/port** |

Confirmed: `grep -c "connection authorized"` = **0** across the whole log. There
is no way to attribute any crash to a client retrospectively, and none of the
retained detail distinguishes the 39 exit-code-2 events from one another.

Two changes make the next occurrence diagnosable. Both are reversible and
neither restarts the postmaster if applied via `ALTER SYSTEM` + `pg_ctl reload`:

```sql
ALTER SYSTEM SET log_connections = on;
ALTER SYSTEM SET log_disconnections = on;
ALTER SYSTEM SET log_line_prefix = '%m [%p] app=%a client=%h';
SELECT pg_reload_conf();
```

`%a` and `%h` are the missing fields: the client application name and its
address. With those, the next crash names its victim.

### 5.1 APPLIED 2026-09-30

Verified all four were at `source = default` (no prior drift), then applied via
`ALTER SYSTEM` + `pg_reload_conf()`:

| Setting | Before | After | Source |
|---|---|---|---|
| `log_connections` | off | **on** | configuration file |
| `log_disconnections` | off | **on** | configuration file |
| `log_line_prefix` | `%m [%p]` | **`%m [%p] app=%a client=%h`** | configuration file |

Smoke test — the postmaster was **not** restarted
(`pg_postmaster_start_time()` unchanged at `2026-09-22 05:49:30`,
`RestartCount=0`), and the new fields render immediately:

```text
[599540] app=[unknown] client=[local]LOG:  connection received: host=[local]
[599540] app=psql client=[local]LOG:  connection authorized: user=airflow database=airflow application_name=psql
[599548] app=pg_isready client=[local]LOG:  connection authorized: ...
```

Airflow healthy (`Up 3 hours`), Postgres `Up 8 days (healthy)`, 15 airflow
connections live, no active query longer than 0 s.

Rollback: `ALTER SYSTEM RESET <setting>; SELECT pg_reload_conf();`

**Two sources for the same three values, on purpose.** The live host was fixed
with `ALTER SYSTEM` (no container restart needed), and the same settings were
also added to the `postgres` service `command:` in `deploy/analytics/compose.yaml`
so a recreated container keeps them. PostgreSQL precedence is command-line
`-c` > `postgresql.auto.conf` > `postgresql.conf`, so the compose `command:`
wins once the container is recreated and the `ALTER SYSTEM` entries become
redundant rather than conflicting. The compose file is the durable source of
truth; the `ALTER SYSTEM` entries only cover the container's current lifetime.

Note the two fields are redundant but both wanted: `%a` is the client-declared
application name (Airflow sets none, so it will read `[unknown]` — still
distinguishes it from a `psql` or `pg_isready`), and `%h` is the peer address.

Also worth fixing regardless of this investigation: **every one of the 22
containers on this host has `Memory=0`** — no memory limit at all — on a host
with 10.8 GiB RAM and 4 GiB swap shared between LaundryTwin's analytics stack
(ClickHouse 1.29 GiB, two Airflow components ~0.91 GiB each) and an unrelated
LibreChat/MongoDB/Meilisearch/Arcane stack. The 22 OOM kills are all from that
unbounded sharing. That is a separate incident, but it is also why this host has
no memory headroom to absorb a backend failure gracefully.

## 6. Two corrections to the earlier account

Stated plainly, because both were wrong:

1. **"The Postgres logs contain no detail."** They contain an explicit cause
   for 55 of 59 events, in two distinct signatures. The claim of an
   unrecoverable blank was wrong.
2. **"The trigger was never determined and must not be recorded as benign."**
   The trigger is still undetermined, so that part holds — but the reason is
   now specific and fixable (`log_connections` off, no `%a`/`%h` in the prefix),
   not a general absence of evidence.

Also corrected: an earlier note recorded `dmesg` as empty. It is not empty —
`journalctl -k` carries all 22 OOM events. That earlier reading would have
hidden the entire host memory-pressure history.

## 7. Open items

- [x] Apply the logging settings in §5 — **done 2026-09-30**, verified in §5.1.
- [ ] Watch for the next reinitialization and capture the full crash window;
      the client is now identifiable. This document should then be updated with
      the actual cause.
- [ ] Decide memory limits for the host (§5, second half) as its own change.
- [ ] 19 of the 59 crashes have no OOM within 30 min. Whether the 09-18 cluster
      has a different cause is untested.
- [ ] 4 of the 55 cause lines do not account for all 59 reinitializations. The
      remainder are either duplicate lines or events whose cause line was lost;
      not resolved.